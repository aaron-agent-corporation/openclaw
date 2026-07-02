/**
 * Associative ranking (Phase 3, 03-04; extended Phase 5, 05-04). Uses the per-agent
 * associative context (topic boxes + their linked tags/entities + §7 importance, read via the
 * `memory-core-host-associative` SDK seam) to re-weight memory search hits, then re-sorts.
 *
 * 03-04 baseline: a hit whose snippet mentions any known recall key (topic/tag/entity) gets a
 * gentle multiplicative nudge. 05-04 adds two RETR-01 signals on top:
 *   - an EXACT entity-key mention gets a stronger (capped) boost than the generic key nudge,
 *     so a precise reference (the "Fidel case") outranks a coarse semantic-only hit (§9);
 *   - the matched box's normalized importance breaks near-ties (a higher-importance box's hit
 *     ranks above a lower-importance one at the same base score).
 *
 * Pure and side-effect free — writes nothing, does not mutate inputs, and is a no-op when the
 * associative store is empty (the default when conversational memory is off), so out-of-the-box
 * search behavior is unchanged.
 */
import type { AssociativeContext } from "openclaw/plugin-sdk/memory-core-host-associative";
import { buildAssociativeIndexRecords } from "./associative-index.js";

// TUNABLE (Phase 4): multiplicative score nudge for a hit that mentions any recall key.
// Small on purpose — associative context reorders near-ties, it does not dominate relevance.
const ASSOCIATIVE_BOOST = 0.15;
// TUNABLE (Phase 5 — §9): stronger, capped nudge for an EXACT entity-key mention. A precise
// entity reference is a much higher-precision recall signal than a coarse topic-word overlap,
// so it must be able to lift a lower-scored exact hit above a higher-scored coarse hit.
const ENTITY_KEY_BOOST = 0.6;
// TUNABLE (Phase 5): importance only breaks near-ties (it must not dominate text/vector
// relevance), so its contribution is a small fraction of the base score.
const IMPORTANCE_TIEBREAK_WEIGHT = 0.05;

type BoxKey = { key: string; importance: number | null; isEntity: boolean };

/**
 * Collect the distinct lowercased recall keys with their owning box's importance + whether the
 * key is an exact entity key (vs a coarser topic/tag). Keys are read from the shared associative
 * index projection (`buildAssociativeIndexRecords`) rather than re-derived inline, so the index
 * has a real production caller (05-06). Entity keys win over topic/tag keys on the same string
 * so an exact entity mention is scored at the stronger boost; the higher-importance owning box
 * wins a shared key.
 */
function boxKeys(context: AssociativeContext): BoxKey[] {
  const byKey = new Map<string, BoxKey>();
  const register = (key: string, importance: number | null, isEntity: boolean) => {
    const existing = byKey.get(key);
    if (
      existing == null ||
      (isEntity && !existing.isEntity) ||
      (isEntity === existing.isEntity && (importance ?? 0) > (existing.importance ?? 0))
    ) {
      byKey.set(key, { key, importance, isEntity });
    }
  };
  for (const record of buildAssociativeIndexRecords(context)) {
    // Entity keys first so the entity classification wins a key shared with a topic/tag.
    for (const key of record.entityKeys) {
      register(key, record.importance, true);
    }
    for (const key of record.recallKeys) {
      register(key, record.importance, false);
    }
  }
  return Array.from(byKey.values());
}

/**
 * Return a re-ranked copy of `results`: each matched hit is returned as a NEW object carrying its
 * BOOSTED score (exact entity keys stronger than coarse topic/tag keys), with the matched box's
 * importance as a near-tie breaker, then the list is re-sorted by score (stable for ties). The
 * boosted score must travel on the returned hit — not just its position — so a downstream score
 * reader or re-sorter cannot silently undo the associative re-rank. Inputs are not mutated. When
 * there are no recall keys the original ordering is returned as-is.
 */
export function augmentMemoryResultsWithAssociativeContext<
  T extends { snippet: string; score: number },
>(params: {
  results: readonly T[];
  context: AssociativeContext;
  boost?: number;
  entityBoost?: number;
}): T[] {
  const keys = boxKeys(params.context);
  if (keys.length === 0 || params.results.length === 0) {
    return [...params.results];
  }
  const keyBoost = params.boost ?? ASSOCIATIVE_BOOST;
  const entityBoost = params.entityBoost ?? ENTITY_KEY_BOOST;
  const scored = params.results.map((result, index) => {
    const haystack = result.snippet.toLowerCase();
    let matchedEntity: BoxKey | undefined;
    let matchedKey: BoxKey | undefined;
    for (const entry of keys) {
      if (!haystack.includes(entry.key)) {
        continue;
      }
      matchedKey ??= entry;
      if (entry.isEntity) {
        matchedEntity ??= entry;
      }
    }
    const matched = matchedEntity ?? matchedKey;
    if (matched == null) {
      return { result, index, score: result.score };
    }
    const boost = matchedEntity ? entityBoost : keyBoost;
    // Importance breaks near-ties without dominating relevance.
    const importanceLift = 1 + IMPORTANCE_TIEBREAK_WEIGHT * (matched.importance ?? 0);
    const boostedScore = result.score * (1 + boost) * importanceLift;
    // Carry the boosted score on a new hit object so the re-rank survives any later score read.
    return { result: { ...result, score: boostedScore }, index, score: boostedScore };
  });
  // Stable sort: higher score first, original order breaks exact ties.
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((entry) => entry.result);
}
