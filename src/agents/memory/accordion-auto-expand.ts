/**
 * Accordion-aware retrieval auto-expand (Phase 5, 05-04 / RETR-01; spec §6.4/§6.6/§9). Decides,
 * for the current turn's query, whether a strong retrieval match against the enriched
 * box/entity/tag rollups justifies auto-expanding a collapsed box back into the model's context
 * — conservatively (strong-match only, recall-safety-first D-07/D-09) and with NO silent
 * fallback to a weaker query.
 *
 * Split:
 *   - `resolveRetrievalAutoExpand` is the PURE decision (query + associative context → best
 *     collapsed box + normalized score + expand/no-expand). It mutates no module state and
 *     performs NO store write, so it is unit-testable without a DB and safe to replay (the
 *     replay-eval gate reuses it against a real agent's store without polluting render state).
 *   - `applyRetrievalAutoExpand` runs the decision, and on a strong match flips the box to live
 *     via the 05-01 `autoExpandBox` write path — which durably stamps `recalled_at_seq` to the
 *     current head so the recalled marker/badge (accordion-extension / accordion-ui) shows for
 *     exactly this turn — and appends the §13 decision-log event.
 *
 * The score is a normalized lexical overlap between the query and each collapsed box's indexed
 * rollup text + labels, with an exact entity-key mention treated as a strong precision signal.
 * Local, deterministic, no model call.
 */
import type { AssociativeContext } from "openclaw/plugin-sdk/memory-core-host-associative";
import {
  ACCORDION_STRONG_MATCH_CUTOFF,
  ACCORDION_SUPPRESSION_CUTOFF_BUMP,
} from "./accordion-constants.js";
import { autoExpandBox } from "./associative-enrichment-writes.js";

const MIN_TOKEN_LENGTH = 3;

/** The auto-expand decision for one turn. */
export type RetrievalAutoExpandDecision = {
  /** The best-matching collapsed box, or null when nothing matched. */
  boxId: string | null;
  /** Normalized retrieval-match score of the best candidate, [0,1]. */
  score: number;
  /** The conservative strong-match cutoff in force (base cutoff, before any suppression bump). */
  cutoff: number;
  /** True when the score cleared the (effective) cutoff and the box was marked for expansion. */
  expanded: boolean;
  /**
   * The winning box's `summary_embedding_ref` (05-06), or null. Lets a decision be correlated to
   * the exact enriched-rollup version it matched in the §13 decision log.
   */
  indexRef: string | null;
  /**
   * True when the winning box carried a `suppression_rollup` note AND the higher effective cutoff
   * was applied (a lexical-only match). False when an exact-entity mention overrode suppression
   * (recall-safety-first) or the box was not suppressed.
   */
  suppressed: boolean;
};

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length >= MIN_TOKEN_LENGTH);
}

/**
 * Normalized lexical match score in [0,1] between the query tokens and one box's indexed text
 * (rollup summary + topic + tag/entity labels). An exact entity-key mention floors the score at
 * a strong value so a precise reference outranks a coarse topic overlap (§9). Denominator is the
 * box's own token count so a fully-covered small rollup can reach a strong score.
 */
function scoreBoxMatch(
  queryTokens: ReadonlySet<string>,
  box: AssociativeContext["boxes"][number],
): { score: number; exactEntity: boolean } {
  const boxText = [box.topic ?? "", box.summary ?? "", ...box.tags, ...box.entities].join(" ");
  const boxTokens = tokenize(boxText);
  if (boxTokens.length === 0 || queryTokens.size === 0) {
    return { score: 0, exactEntity: false };
  }
  const boxTokenSet = new Set(boxTokens);
  let overlap = 0;
  for (const token of boxTokenSet) {
    if (queryTokens.has(token)) {
      overlap += 1;
    }
  }
  const lexical = overlap / boxTokenSet.size;
  // Exact entity-key mention: a much higher-precision recall signal than coarse overlap.
  const exactEntity = box.entities.some((entity) => {
    const key = entity.trim().toLowerCase();
    return key.length >= MIN_TOKEN_LENGTH && queryTokens.has(key);
  });
  return { score: exactEntity ? Math.max(lexical, 0.75) : lexical, exactEntity };
}

/**
 * Pure decision: score the query against every COLLAPSED box's enriched rollup and pick the
 * best. On a strong match (≥ cutoff) return `expanded: true` with the winning box. Empty store
 * or weak best → `expanded: false` with the best score (no downgraded query — the caller must
 * NOT silently fall back to a weaker mode, §9). Mutates no module state and writes no store, so
 * replaying it against a real agent's store never pollutes render/marker state.
 */
export function resolveRetrievalAutoExpand(params: {
  agentId: string;
  sessionKey: string;
  query: string;
  context: AssociativeContext;
  cutoff?: number;
}): RetrievalAutoExpandDecision {
  const cutoff = params.cutoff ?? ACCORDION_STRONG_MATCH_CUTOFF;
  const queryTokens = new Set(tokenize(params.query));
  // Best box that clears its own effective cutoff (the expansion candidate).
  let bestBoxId: string | null = null;
  let bestScore = 0;
  let bestIndexRef: string | null = null;
  let bestSuppressed = false;
  // Best raw score across all collapsed boxes, reported when nothing is eligible (no downgrade).
  let topScore = 0;
  for (const box of params.context.boxes) {
    // Only collapsed boxes are candidates — a live box is already in context verbatim.
    if (box.state !== "collapsed") {
      continue;
    }
    const { score, exactEntity } = scoreBoxMatch(queryTokens, box);
    if (score > topScore) {
      topScore = score;
    }
    // Low-salience suppression (05-06): a box carrying a suppression note needs a HIGHER effective
    // cutoff, but ONLY on a lexical-only match — an exact-entity mention is never suppressed so a
    // precise reference to a suppressed topic still auto-expands (recall-safety-first, D-07/D-09).
    const suppressed = box.suppressionRollup != null && !exactEntity;
    const effectiveCutoff = suppressed ? cutoff + ACCORDION_SUPPRESSION_CUTOFF_BUMP : cutoff;
    if (score >= effectiveCutoff && score > bestScore) {
      bestScore = score;
      bestBoxId = box.boxId;
      bestIndexRef = box.summaryEmbeddingRef;
      bestSuppressed = suppressed;
    }
  }
  const expanded = bestBoxId != null;
  return {
    boxId: expanded ? bestBoxId : null,
    score: expanded ? bestScore : topScore,
    cutoff,
    expanded,
    indexRef: expanded ? bestIndexRef : null,
    suppressed: bestSuppressed,
  };
}

/** The §13 decision-log payload for one auto-expand evaluation. */
export type RetrievalAutoExpandLog = {
  boxId: string | null;
  score: number;
  cutoff: number;
  expanded: boolean;
  /** Winning box's summary_embedding_ref (05-06) — pins the decision to the matched rollup version. */
  indexRef: string | null;
  /** True when the higher suppression cutoff was applied to the winning box (lexical-only match). */
  suppressed: boolean;
};

/**
 * Run the decision and, on a strong match, flip the box to live via the 05-01 write path so the
 * seq-walk renders it verbatim this turn (no one-turn lag, §6.6). Returns the decision plus a
 * §13 log payload the caller appends to the decision log. Store write failures are swallowed so
 * a flip error never breaks the turn (recall-safety-first: the box simply stays as it was).
 */
export function applyRetrievalAutoExpand(params: {
  agentId: string;
  sessionKey: string;
  query: string;
  context: AssociativeContext;
  cutoff?: number;
  env?: NodeJS.ProcessEnv;
}): { decision: RetrievalAutoExpandDecision; log: RetrievalAutoExpandLog } {
  const decision = resolveRetrievalAutoExpand(params);
  if (decision.expanded && decision.boxId != null) {
    try {
      autoExpandBox({
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        boxId: decision.boxId,
        env: params.env,
      });
    } catch {
      // Never break a turn over an auto-expand flip; the box just stays collapsed.
    }
  }
  return {
    decision,
    log: {
      boxId: decision.boxId,
      score: decision.score,
      cutoff: decision.cutoff,
      expanded: decision.expanded,
      indexRef: decision.indexRef,
      suppressed: decision.suppressed,
    },
  };
}
