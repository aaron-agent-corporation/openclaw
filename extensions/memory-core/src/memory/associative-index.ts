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
 * content; `importance` and `entityKeys` are the ranking signals consumed by the re-rank.
 */
export type AssociativeIndexRecord = {
  kind: AssociativeIndexRecordKind;
  boxId: string;
  /** Searchable rollup text (box summary, or an entity/tag rollup line). */
  text: string;
  /** Normalized §7 importance ∈ [0,1] of the owning box, or null before enrichment. */
  importance: number | null;
  /** Distinct lowercased exact entity keys linked to the owning box. */
  entityKeys: string[];
};

// Ignore very short labels; they match too much to be meaningful recall/entity keys.
const MIN_KEY_LENGTH = 3;

function normalizeKey(label: string | null | undefined): string | null {
  const key = label?.trim().toLowerCase();
  return key != null && key.length >= MIN_KEY_LENGTH ? key : null;
}

/** Distinct lowercased entity keys linked to a single box. */
function boxEntityKeys(box: AssociativeBoxContext): string[] {
  const keys = new Set<string>();
  for (const entity of box.entities) {
    const key = normalizeKey(entity);
    if (key != null) {
      keys.add(key);
    }
  }
  return Array.from(keys);
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
 * for each enriched box (its rollup summary), plus an `entity` record and a `tag` record
 * carrying the box's linked entity/tag labels so an exact key mention is retrievable even when
 * the coarse box summary does not spell it out. Boxes with no summary and no labels contribute
 * nothing (nothing to index). Empty store → no records.
 */
export function buildAssociativeIndexRecords(
  context: AssociativeContext,
): AssociativeIndexRecord[] {
  const records: AssociativeIndexRecord[] = [];
  for (const box of context.boxes) {
    const entityKeys = boxEntityKeys(box);
    const summary = box.summary?.trim();
    const topic = box.topic?.trim();
    if (summary) {
      records.push({
        kind: "box",
        boxId: box.boxId,
        text: topic ? `${topic} — ${summary}` : summary,
        importance: box.importance,
        entityKeys,
      });
    }
    if (box.entities.length > 0) {
      records.push({
        kind: "entity",
        boxId: box.boxId,
        text: box.entities.join(", "),
        importance: box.importance,
        entityKeys,
      });
    }
    if (box.tags.length > 0) {
      records.push({
        kind: "tag",
        boxId: box.boxId,
        text: box.tags.join(", "),
        importance: box.importance,
        entityKeys,
      });
    }
  }
  return records;
}
