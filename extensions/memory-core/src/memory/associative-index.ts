/**
 * Associative retrieval index (Phase 5, 05-04 / RETR-01). Projects the box / entity / tag
 * rollup summaries the 05-03 dreaming pass persisted (box.summary + importance, linked
 * entity/tag labels) into retrievable index records that flow through the SAME memory-core
 * retrieval + re-ranking path — there is NO second memory slot and no new tool. The records
 * are derived read-only from the associative read seam (`memory-core-host-associative`); the
 * dreaming pass is the write side. An empty associative store yields no records (default-off
 * no-op preserved).
 */
import type {
  AssociativeContext,
  AssociativeBoxContext,
} from "openclaw/plugin-sdk/memory-core-host-associative";

/** Which enriched summary an index record was projected from. */
export type AssociativeIndexRecordKind = "box" | "entity" | "tag";

/**
 * One retrievable record projected from an enriched box. `text` is the searchable rollup
 * content; `importance`, `entityKeys`, and `recallKeys` are the ranking signals consumed by the
 * re-rank; `indexRef` pins the record to the exact enriched-rollup version it was built from.
 */
export type AssociativeIndexRecord = {
  kind: AssociativeIndexRecordKind;
  boxId: string;
  /** Searchable rollup text (box summary/topic, or an entity/tag rollup line). */
  text: string;
  /** Normalized §7 importance ∈ [0,1] of the owning box, or null before enrichment. */
  importance: number | null;
  /** Distinct lowercased exact entity keys linked to the owning box. */
  entityKeys: string[];
  /**
   * Distinct lowercased non-entity recall keys (topic + tags) of the owning box. Carried
   * box-level on every record so the re-rank can register the box's coarse recall keys from the
   * index instead of re-deriving them inline (05-06 — gives the projection a production caller).
   */
  recallKeys: string[];
  /**
   * The box's `summary_embedding_ref` (content-derived rollup version), or null before
   * enrichment. Consumer for the previously write-only column (05-06): correlates an indexed
   * record / auto-expand decision to the exact rollup version it matched.
   */
  indexRef: string | null;
};

// Ignore very short labels; they match too much to be meaningful recall/entity keys.
const MIN_KEY_LENGTH = 3;

function normalizeKey(label: string | null | undefined): string | null {
  const key = label?.trim().toLowerCase();
  return key != null && key.length >= MIN_KEY_LENGTH ? key : null;
}

/** Distinct lowercased keys from a label list (min-length filtered). */
function distinctKeys(labels: Iterable<string | null | undefined>): string[] {
  const keys = new Set<string>();
  for (const label of labels) {
    const key = normalizeKey(label);
    if (key != null) {
      keys.add(key);
    }
  }
  return Array.from(keys);
}

/** Distinct lowercased entity keys linked to a single box. */
function boxEntityKeys(box: AssociativeBoxContext): string[] {
  return distinctKeys(box.entities);
}

/** Distinct lowercased non-entity recall keys (topic + tags) of a single box. */
function boxRecallKeys(box: AssociativeBoxContext): string[] {
  return distinctKeys([box.topic, ...box.tags]);
}

/** The distinct lowercased exact entity keys across the whole associative context. */
export function entityKeysFromContext(context: AssociativeContext): string[] {
  const keys = new Set<string>();
  for (const box of context.boxes) {
    for (const key of boxEntityKeys(box)) {
      keys.add(key);
    }
  }
  return Array.from(keys);
}

/**
 * Project the enriched associative context into retrievable index records: one `box` record
 * for each box with a rollup summary or topic, plus an `entity` record and a `tag` record
 * carrying the box's linked entity/tag labels so an exact key mention is retrievable even when
 * the coarse box summary does not spell it out. Every record carries the owning box's
 * `entityKeys` / `recallKeys` (the re-rank registers keys from these) and its `indexRef`
 * (= summary_embedding_ref). A box with no summary, topic, entities, or tags contributes
 * nothing (nothing to index). Empty store → no records.
 */
export function buildAssociativeIndexRecords(
  context: AssociativeContext,
): AssociativeIndexRecord[] {
  const records: AssociativeIndexRecord[] = [];
  for (const box of context.boxes) {
    const entityKeys = boxEntityKeys(box);
    const recallKeys = boxRecallKeys(box);
    // Box-level signals shared by every record projected from this box.
    const common = { boxId: box.boxId, importance: box.importance, entityKeys, recallKeys };
    const indexRef = box.summaryEmbeddingRef;
    const summary = box.summary?.trim();
    const topic = box.topic?.trim();
    // Emit a box record when the box has any coarse rollup content — summary OR topic — so a
    // topic-only (not-yet-summarized) box still contributes its topic recall key to the index.
    if (summary || topic) {
      const text = summary && topic ? `${topic} — ${summary}` : (summary ?? topic ?? "");
      records.push({ kind: "box", ...common, text, indexRef });
    }
    if (box.entities.length > 0) {
      records.push({ kind: "entity", ...common, text: box.entities.join(", "), indexRef });
    }
    if (box.tags.length > 0) {
      records.push({ kind: "tag", ...common, text: box.tags.join(", "), indexRef });
    }
  }
  return records;
}
