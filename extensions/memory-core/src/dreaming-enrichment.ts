/**
 * Dreaming associative enrichment producer (Phase 5, 05-03; DREAM-01 + TAG-01).
 *
 * Connects the dreaming tier to the new core turns/spans/boxes store — the audit found the
 * dreaming stack never touched it. Per box it writes, THROUGH the 05-01 write seam:
 *   - a real multi-turn rollup summary (superseding the segment-spans first-line truncation),
 *   - a normalized additive importance score (§7 formula, inputs stored for TUNE-02),
 *   - a `summary_embedding_ref` marker,
 * and derives DAG parent edges from tag co-occurrence (broader tag → narrower tag), linking
 * them via the cycle-guarded `linkTagParent`.
 *
 * Local-only (§13): the rollup is a deterministic local heuristic over the box's own turns —
 * no remote model, no network. Bounded (per-night caps) and idempotent (the seam upserts, and
 * existing DAG edges are skipped), so re-running on unchanged data is a no-op. Every box
 * decision is emitted to the §13 JSONL decision log with its score + inputs for later
 * precision/recall review.
 *
 * Seam-only: this module imports the public read/write SDK subpaths, never core `src/**`.
 */
import {
  computeImportance,
  ENRICHMENT_MAX_BOXES_PER_NIGHT,
  ENRICHMENT_MAX_TAG_EDGES_PER_NIGHT,
  ENRICHMENT_MIN_COOCCURRENCE_WEIGHT,
  ENRICHMENT_ROLLUP_MAX_CHARS,
  ENRICHMENT_ROLLUP_MAX_TURNS,
  readBoxRollupInputs,
  readTagCooccurrence,
  type BoxRollupInputs,
} from "openclaw/plugin-sdk/memory-core-host-associative";
import {
  linkTagParent,
  listEnrichmentTagEdges,
  writeBoxEnrichment,
} from "openclaw/plugin-sdk/memory-core-host-associative-write";
import { appendMemoryHostEvent } from "openclaw/plugin-sdk/memory-host-events";
import { resolveMemoryCoreNowMs, resolveMemoryCoreTimestamp } from "./time.js";

type Logger = { warn: (message: string) => void };

export type AssociativeEnrichmentResult = {
  boxesEnriched: number;
  parentEdgesLinked: number;
};

export type RunAssociativeEnrichmentOptions = {
  agentId: string;
  sessionKey: string;
  env?: NodeJS.ProcessEnv;
  /** Workspace dir for the §13 decision log; omit to skip event emission (e.g. seam-only tests). */
  workspaceDir?: string;
  /** Override the per-night box cap (defaults to the tunable constant). Tests pin this. */
  maxBoxes?: number;
  /** Override the per-night DAG edge cap. */
  maxEdges?: number;
  nowMs?: number;
  logger?: Logger;
};

/**
 * Build a real rollup summary from a box's non-noise turns. Deterministic local heuristic:
 * "topic — role: first-sentence" lines for up to N turns, bounded to a char cap. Multi-turn,
 * not the single first-line truncation it replaces. No model/network (§13).
 */
function buildRollupSummary(box: BoxRollupInputs): string {
  const topicPrefix = box.topic ? `${box.topic} — ` : "";
  const lines = box.turns.slice(0, ENRICHMENT_ROLLUP_MAX_TURNS).map((turn) => {
    const firstSentence =
      turn.content
        .replace(/\s+/g, " ")
        .trim()
        .split(/(?<=[.!?])\s/, 1)[0] ?? "";
    return `${turn.role}: ${firstSentence}`.trim();
  });
  const body = lines.join(" | ");
  const summary = `${topicPrefix}${body}`.trim();
  return summary.length > ENRICHMENT_ROLLUP_MAX_CHARS
    ? summary.slice(0, ENRICHMENT_ROLLUP_MAX_CHARS)
    : summary;
}

/**
 * Content-derived, stable ref for the rollup summary. A real value populates the previously
 * dead `boxes.summary_embedding_ref` column; downstream retrieval (05-04) indexes the rollup
 * against this ref. Deterministic so idempotent re-runs produce the identical ref.
 */
function summaryEmbeddingRef(boxId: string, summary: string): string {
  let hash = 0;
  for (let index = 0; index < summary.length; index += 1) {
    hash = (hash * 31 + summary.charCodeAt(index)) | 0;
  }
  return `rollup:${boxId}:${(hash >>> 0).toString(16)}`;
}

/**
 * Derive candidate broader→narrower DAG parent edges for one box's topic tag. A tag that
 * co-occurs on a superset of the topic's targets is broader (parent); the topic tag is the
 * narrower child. Conservative: only proposes an edge above the co-occurrence-weight floor,
 * recall-safety-first so weak incidental overlap does not over-connect the graph.
 */
/**
 * Approximate a tag's target breadth as the distinct targets it shares with any other tag
 * (the union of its neighbors' shared-target refs). This under-counts targets a tag owns
 * exclusively, but for hierarchy detection we only compare tags that co-occur, so the shared
 * surface is the meaningful breadth. Cheap and local; deep-pass 05-06 can refine.
 */
function childTargetBreadth(traversal: ReturnType<typeof readTagCooccurrence>): number {
  const targets = new Set<string>();
  for (const neighbor of traversal.neighbors) {
    for (const target of neighbor.targets) {
      targets.add(`${target.targetType}:${target.targetId}`);
    }
  }
  return targets.size;
}

function candidateParentEdges(params: {
  agentId: string;
  sessionKey: string;
  env?: NodeJS.ProcessEnv;
  box: BoxRollupInputs;
}): Array<{ childTagId: string; parentTagId: string }> {
  const topic = params.box.topic;
  if (topic == null || topic.trim().length === 0) {
    return [];
  }
  const cooccur = (tag: string) =>
    readTagCooccurrence({
      agentId: params.agentId,
      ...(params.env ? { env: params.env } : {}),
      sessionKey: params.sessionKey,
      tag,
    });
  const traversal = cooccur(topic);
  const child = traversal.tag;
  if (child == null) {
    return [];
  }
  // The child's own breadth = distinct targets it is linked to. A neighbor is a *broader*
  // parent when it co-occurs across all of the child's targets AND is itself linked to more
  // targets than the child (strictly broader). Conservative and recall-safety-first: incidental
  // partial overlap does not create a hierarchy.
  const childBreadth = childTargetBreadth(traversal);
  if (childBreadth === 0) {
    return [];
  }
  const edges: Array<{ childTagId: string; parentTagId: string }> = [];
  for (const neighbor of traversal.neighbors) {
    if (neighbor.tagId === child.tagId) {
      continue;
    }
    // Must co-occur across the child's whole (shared) target set, and clear the floor so a
    // single incidental overlap does not create a hierarchy.
    if (neighbor.weight < childBreadth || neighbor.weight < ENRICHMENT_MIN_COOCCURRENCE_WEIGHT) {
      continue;
    }
    // Strictly broader: the parent must span more targets than the child.
    if (childTargetBreadth(cooccur(neighbor.label)) <= childBreadth) {
      continue;
    }
    edges.push({ childTagId: child.tagId, parentTagId: neighbor.tagId });
  }
  return edges;
}

/**
 * Run one enrichment pass over the agent's boxes. Reads the store via the read seam, writes
 * rollups/importance/DAG through the write seam, bounded + idempotent + decision-logged.
 */
export async function runAssociativeEnrichment(
  options: RunAssociativeEnrichmentOptions,
): Promise<AssociativeEnrichmentResult> {
  const maxBoxes = options.maxBoxes ?? ENRICHMENT_MAX_BOXES_PER_NIGHT;
  const maxEdges = options.maxEdges ?? ENRICHMENT_MAX_TAG_EDGES_PER_NIGHT;
  const scope = { agentId: options.agentId, ...(options.env ? { env: options.env } : {}) };
  const boxInputs = readBoxRollupInputs({
    agentId: options.agentId,
    sessionKey: options.sessionKey,
    ...(options.env ? { env: options.env } : {}),
  });

  // Snapshot existing DAG edges once so idempotent re-runs skip already-linked parents
  // without a per-edge round trip.
  const existingEdgeKeys = new Set(
    listEnrichmentTagEdges(scope).map((edge) => `${edge.child_tag_id}->${edge.parent_tag_id}`),
  );

  const nowMs = resolveMemoryCoreNowMs(options.nowMs);
  const events: Array<{
    boxId: string;
    importance: number;
    inputs: { recurrenceCount: number; turnDepth: number; effortSignal: number };
    summaryChars: number;
    linkedParents: number;
  }> = [];

  let boxesEnriched = 0;
  let parentEdgesLinked = 0;

  for (const box of boxInputs) {
    if (boxesEnriched >= maxBoxes) {
      break;
    }
    const { score, inputs } = computeImportance({
      recurrenceCount: box.recurrenceCount,
      turnDepth: box.turnDepth,
      effortSignal: box.effortSignal,
    });
    const summary = buildRollupSummary(box);
    const embeddingRef = summaryEmbeddingRef(box.boxId, summary);
    writeBoxEnrichment({
      ...scope,
      box: {
        boxId: box.boxId,
        sessionKey: options.sessionKey,
        importance: score,
        summary,
        summaryEmbeddingRef: embeddingRef,
      },
    });

    let linkedForBox = 0;
    for (const edge of candidateParentEdges({
      agentId: options.agentId,
      sessionKey: options.sessionKey,
      ...(options.env ? { env: options.env } : {}),
      box,
    })) {
      if (parentEdgesLinked >= maxEdges) {
        break;
      }
      const key = `${edge.childTagId}->${edge.parentTagId}`;
      if (existingEdgeKeys.has(key)) {
        continue;
      }
      try {
        linkTagParent({ ...scope, childTagId: edge.childTagId, parentTagId: edge.parentTagId });
        existingEdgeKeys.add(key);
        linkedForBox += 1;
        parentEdgesLinked += 1;
      } catch (err) {
        // The cycle guard throws on a would-be cycle; that is expected and non-fatal —
        // log and move on so one bad candidate cannot abort the sweep (§13 tampering guard).
        options.logger?.warn(
          `memory-core: enrichment skipped cyclic tag edge ${key}: ${String(err)}`,
        );
      }
    }

    boxesEnriched += 1;
    events.push({
      boxId: box.boxId,
      importance: score,
      inputs,
      summaryChars: summary.length,
      linkedParents: linkedForBox,
    });
  }

  // Emit the §13 decision log after the mutations so a failed write never logs a phantom
  // decision. Best-effort: a logging failure must not fail the sweep.
  if (options.workspaceDir) {
    const workspaceDir = options.workspaceDir;
    const timestamp = resolveMemoryCoreTimestamp(nowMs);
    for (const event of events) {
      try {
        await appendMemoryHostEvent(workspaceDir, {
          type: "memory.enrich.box",
          timestamp,
          agentId: options.agentId,
          boxId: event.boxId,
          importance: event.importance,
          inputs: event.inputs,
          summaryChars: event.summaryChars,
          linkedParents: event.linkedParents,
        });
      } catch (err) {
        options.logger?.warn(
          `memory-core: failed to write enrichment decision log for box ${event.boxId}: ${String(err)}`,
        );
      }
    }
  }

  return { boxesEnriched, parentEdgesLinked };
}
