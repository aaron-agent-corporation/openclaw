/**
 * Replay precision/recall harness (Phase 5, 05-05 / D-03 acceptance gate). A durable, re-runnable
 * evaluation of the accordion-aware auto-expand decisions over the BACKFILLED per-agent history
 * (the ~1,881-turn/~19-day `main` spike dataset, seeded by `openclaw memory backfill` in Phase 4).
 * This is the phase gate: it proves the 05-01..05-04 thin vertical surfaces the right old matter,
 * and it is scored recall-safety-first (a still-needed topic wrongly collapsed / not surfaced is
 * the worst outcome — mirrors Phase 4 D-07/D-09).
 *
 * Unlike Phase 4's one-time tuning harness (removed after locking constants), this stays in the
 * tree as a re-runnable gate. It reuses the backfilled turns/spans/boxes store through the
 * existing read seam — it never re-derives the dataset — and replays the SAME pure decision
 * function (`resolveRetrievalAutoExpand`) the runtime uses, so the gate can never drift from
 * production behavior.
 *
 * Reference derivation (topic-switch, Phase 4 approach): at each eval point, a collapsed box is
 * "still needed" iff the turn query lexically grounds in the box's own topic/entities/summary at
 * or above a reference threshold. That reference is what the recorded auto-expand decision is
 * scored against — a needed-but-not-surfaced box is a recall failure; a surfaced-but-not-needed
 * box is a precision failure.
 */
import { resolveRetrievalAutoExpand } from "./accordion-auto-expand.js";
import { readAssociativeContext, type AssociativeContext } from "./associative-context.js";
import { scoreRun, type ReplayEvalCounts } from "./replay-eval-objective.js";

/**
 * Reference threshold for "still-needed": a collapsed box counts as needed at an eval point when
 * the query grounds in it at least this strongly. Set at the shipped strong-match cutoff so the
 * gate's ground truth matches the runtime's conservative recall bar (a box the runtime would
 * confidently surface is exactly a box the reference calls still-needed).
 */
export const REPLAY_REFERENCE_CUTOFF = 0.6;

/** One turn to evaluate: the query the model would issue at that point in the replay. */
export type ReplayEvalPoint = {
  query: string;
};

/** Precision/recall + recall-safety score for one replay run. */
export type ReplayEvalResult = {
  /** Fraction of surfaced boxes that were genuinely needed; 1 when nothing was surfaced. */
  precision: number;
  /** Fraction of needed boxes that were surfaced; 1 when nothing was needed. */
  recall: number;
  /** Recall-safety-first aggregate from `scoreRun` (0 is perfect; negative flags failures). */
  recallSafetyScore: number;
  /** Per-decision classification tallies (the evidence behind precision/recall). */
  counts: ReplayEvalCounts;
  /** Number of eval points evaluated (0 when the store held no collapsed boxes). */
  evaluatedPoints: number;
};

/**
 * Lexical grounding score of a query in one collapsed box, reusing the same normalized-overlap
 * shape the auto-expand decision uses (topic + summary + tags + entities, exact-entity floor at
 * 0.75). Kept local and pure so the reference derivation stays deterministic and store-free.
 */
function referenceScore(
  queryTokens: ReadonlySet<string>,
  box: AssociativeContext["boxes"][number],
): number {
  const boxText = [box.topic ?? "", box.summary ?? "", ...box.tags, ...box.entities].join(" ");
  const boxTokens = tokenize(boxText);
  if (boxTokens.length === 0 || queryTokens.size === 0) {
    return 0;
  }
  const boxTokenSet = new Set(boxTokens);
  let overlap = 0;
  for (const token of boxTokenSet) {
    if (queryTokens.has(token)) {
      overlap += 1;
    }
  }
  const lexical = overlap / boxTokenSet.size;
  const exactEntity = box.entities.some((entity) => {
    const key = entity.trim().toLowerCase();
    return key.length >= 3 && queryTokens.has(key);
  });
  return exactEntity ? Math.max(lexical, 0.75) : lexical;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length >= 3);
}

/**
 * Run the replay evaluation for one agent session over a set of eval points. Loads the backfilled
 * associative context (collapsed boxes + rollups) once, then for each point derives the still-
 * needed reference and replays the real auto-expand decision, classifying each into recall/
 * precision correct/failure. Returns precision, recall, and the recall-safety score.
 *
 * Deterministic and re-runnable: given the same store + eval points + cutoff, the score is
 * identical. Tolerant of an empty store (no collapsed boxes → nothing to recall → a clean result),
 * so the gate can be invoked against any agent, including one not yet backfilled.
 */
export function runReplayEval(params: {
  agentId: string;
  sessionKey: string;
  evalPoints: readonly ReplayEvalPoint[];
  /** Strong-match cutoff for the replayed decision. Defaults to the shipped conservative cutoff. */
  cutoff?: number;
  env?: NodeJS.ProcessEnv;
}): ReplayEvalResult {
  const context = readAssociativeContext({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    env: params.env,
  });
  const hasCollapsedBox = context.boxes.some((box) => box.state === "collapsed");

  const counts: ReplayEvalCounts = {
    recallCorrect: 0,
    recallFailures: 0,
    precisionCorrect: 0,
    precisionFailures: 0,
    tokenSavings: 0,
  };

  // No collapsed boxes → no recall opportunities in this store. Still a valid (clean) gate result.
  const evaluatedPoints = hasCollapsedBox ? params.evalPoints.length : 0;

  for (const point of hasCollapsedBox ? params.evalPoints : []) {
    const queryTokens = new Set(tokenize(point.query));
    // Reference: the set of collapsed boxes the query genuinely re-references (still-needed).
    const neededBoxIds = new Set(
      context.boxes
        .filter(
          (box) =>
            box.state === "collapsed" &&
            referenceScore(queryTokens, box) >= REPLAY_REFERENCE_CUTOFF,
        )
        .map((box) => box.boxId),
    );

    // Replay the SAME decision the runtime makes (no store write in the pure resolver).
    const decision = resolveRetrievalAutoExpand({
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      query: point.query,
      context,
      cutoff: params.cutoff,
    });
    const expandedBoxId = decision.expanded ? decision.boxId : null;

    if (neededBoxIds.size > 0) {
      const surfacedNeeded = expandedBoxId != null && neededBoxIds.has(expandedBoxId);
      if (surfacedNeeded) {
        counts.recallCorrect += 1;
      } else {
        // A still-needed topic was not surfaced — the worst outcome (recall-safety-first).
        counts.recallFailures += 1;
        if (expandedBoxId != null) {
          // The wrong box was surfaced instead: that spurious surface is ALSO a precision
          // failure, or a systematic wrong-box expansion would report precision 1.0.
          counts.precisionFailures += 1;
        }
      }
    } else if (expandedBoxId != null) {
      // Surfaced a box the reference says was not needed — a spurious surface (precision failure).
      counts.precisionFailures += 1;
    } else {
      // Correctly left everything collapsed on a fresh topic; context stayed lean (a token saving).
      counts.precisionCorrect += 1;
      counts.tokenSavings += 1;
    }
  }

  const surfaced = counts.recallCorrect + counts.precisionFailures;
  const needed = counts.recallCorrect + counts.recallFailures;
  // Precision/recall default to 1 (nothing surfaced / nothing needed) so an idle gate reads clean.
  const precision = surfaced === 0 ? 1 : counts.recallCorrect / surfaced;
  const recall = needed === 0 ? 1 : counts.recallCorrect / needed;

  return {
    precision,
    recall,
    recallSafetyScore: scoreRun(counts),
    counts,
    evaluatedPoints,
  };
}
