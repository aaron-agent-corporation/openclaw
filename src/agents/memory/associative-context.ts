/**
 * Read-only associative context (Phase 3, 03-04). A compact, plugin-facing view of the
 * per-agent associative store: each topic box with its summary/state plus the tag and
 * entity labels linked to it. This is the single read surface the memory-core extension
 * consumes (via the `memory-core-host-associative` SDK seam) to augment search ranking;
 * it never writes. Keeping it to one function + one shape keeps the public SDK surface
 * narrow — callers do not get the raw row/store APIs.
 */
import { listMemoryAssociations, listMemoryEntities, listMemoryTags } from "./associative-store.js";
import { isSuppressedMemoryNoise } from "./noise.js";
import { getTurns, listBoxes, listSpans, type BoxState } from "./turns-store.js";

export type AssociativeBoxContext = {
  boxId: string;
  topic: string | null;
  summary: string | null;
  state: BoxState;
  tags: string[];
  entities: string[];
};

export type AssociativeContext = {
  boxes: AssociativeBoxContext[];
};

/**
 * Read the associative context for one agent session. Tolerant of an empty store
 * (conversational memory off, or nothing captured yet) — returns no boxes rather than
 * throwing, so callers can treat it as best-effort enrichment.
 */
export function readAssociativeContext(options: {
  agentId: string;
  sessionKey: string;
  env?: NodeJS.ProcessEnv;
}): AssociativeContext {
  const scope = { agentId: options.agentId, sessionKey: options.sessionKey };
  const dbOpts = options.env ? { ...scope, env: options.env } : scope;

  const boxes = listBoxes(dbOpts);
  if (boxes.length === 0) {
    // Fresh object every call: this is a public read surface, so a caller mutating one
    // empty result must not leak into a later empty read.
    return { boxes: [] };
  }

  const tagLabelById = new Map(listMemoryTags(dbOpts).map((tag) => [tag.tag_id, tag.label]));
  const entityLabelById = new Map(
    listMemoryEntities(dbOpts).map((entity) => [entity.entity_id, entity.label]),
  );

  // Box-targeted associations only; tag/entity links to spans/turns are out of scope here.
  const tagsByBox = new Map<string, Set<string>>();
  const entitiesByBox = new Map<string, Set<string>>();
  for (const assoc of listMemoryAssociations(dbOpts)) {
    if (assoc.target_type !== "box") {
      continue;
    }
    if (assoc.tag_id != null) {
      const label = tagLabelById.get(assoc.tag_id);
      if (label != null) {
        (tagsByBox.get(assoc.target_id) ?? setInMap(tagsByBox, assoc.target_id)).add(label);
      }
    }
    if (assoc.entity_id != null) {
      const label = entityLabelById.get(assoc.entity_id);
      if (label != null) {
        (entitiesByBox.get(assoc.target_id) ?? setInMap(entitiesByBox, assoc.target_id)).add(label);
      }
    }
  }

  return {
    boxes: boxes.map((box) => ({
      boxId: box.box_id,
      topic: box.label,
      summary: box.summary,
      state: box.state === "collapsed" ? "collapsed" : "live",
      tags: sortedFrom(tagsByBox.get(box.box_id)),
      entities: sortedFrom(entitiesByBox.get(box.box_id)),
    })),
  };
}

/**
 * Non-noise turn content the dreaming enrichment pass rolls up for one box, in seq order.
 * Kept to `role` + `content` so the producer can build a multi-turn rollup without the raw
 * turn-row/store API. The importance axes are pre-derived here (core owns turn/span/noise
 * logic) so the plugin only calls the pure §7 scorer over them.
 */
export type BoxRollupInputs = {
  boxId: string;
  topic: string | null;
  /** Ordered non-noise turns owned by the box's spans. */
  turns: Array<{ role: string; content: string }>;
  /** Distinct owning spans — a topic re-visit signal (recurrence axis, §7). */
  recurrenceCount: number;
  /** Non-noise turns the box owns (turn-depth axis, §7). */
  turnDepth: number;
  /** Fraction of the box's non-noise turns that are tool/assistant work, in [0,1] (effort axis, §7). */
  effortSignal: number;
};

/**
 * Read the per-box rollup inputs for one agent session: the box's non-noise turns plus the
 * normalized-input axes (recurrence / turn-depth / effort) the §7 importance formula needs.
 * Read-only and tolerant of an empty store (returns no boxes). This is the single read
 * surface the dreaming enrichment producer consumes to generate real rollups and importance
 * without reaching into the raw turns/spans schema.
 */
export function readBoxRollupInputs(options: {
  agentId: string;
  sessionKey: string;
  env?: NodeJS.ProcessEnv;
}): BoxRollupInputs[] {
  const scope = { agentId: options.agentId, sessionKey: options.sessionKey };
  const dbOpts = options.env ? { ...scope, env: options.env } : scope;

  const boxes = listBoxes(dbOpts);
  if (boxes.length === 0) {
    return [];
  }
  const turns = getTurns(dbOpts);
  const spansByBox = new Map<string, Array<{ startSeq: number; endSeq: number }>>();
  for (const span of listSpans(dbOpts)) {
    if (span.box_id == null) {
      continue;
    }
    const list = spansByBox.get(span.box_id) ?? [];
    list.push({ startSeq: span.start_seq, endSeq: span.end_seq });
    spansByBox.set(span.box_id, list);
  }

  return boxes.map((box) => {
    const spans = (spansByBox.get(box.box_id) ?? []).toSorted((a, b) => a.startSeq - b.startSeq);
    const owned: Array<{ role: string; content: string }> = [];
    let effortful = 0;
    for (const span of spans) {
      for (const turn of turns) {
        if (turn.seq < span.startSeq || turn.seq > span.endSeq) {
          continue;
        }
        if (isSuppressedMemoryNoise(turn)) {
          continue;
        }
        owned.push({ role: turn.role, content: turn.content });
        // Effort proxy: assistant/tool turns carry the work signal (tool calls, reasoning);
        // pure user prompts do not. Local, deterministic, no model call (§13).
        if (turn.role !== "user") {
          effortful += 1;
        }
      }
    }
    const turnDepth = owned.length;
    const effortSignal = turnDepth === 0 ? 0 : effortful / turnDepth;
    return {
      boxId: box.box_id,
      topic: box.label,
      turns: owned,
      recurrenceCount: spans.length,
      turnDepth,
      effortSignal,
    };
  });
}

function setInMap(map: Map<string, Set<string>>, key: string): Set<string> {
  const set = new Set<string>();
  map.set(key, set);
  return set;
}

function sortedFrom(set: Set<string> | undefined): string[] {
  return set ? Array.from(set).toSorted() : [];
}
