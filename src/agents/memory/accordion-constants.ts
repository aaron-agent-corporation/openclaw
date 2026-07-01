/**
 * Accordion auto-collapse tuning constants (Phase 2, 02-03; spec §6.3). Single source of
 * truth for the active-tag-set rule. These shipped as escalated-open defaults; Phase 4
 * (TUNE-01) replayed the competing candidates — grok-1 (Jaccard-distance) vs gemini-1
 * (zero-intersection) vs the shipped baseline — over the agent's own backfilled history with
 * a recall-safety-first objective and LOCKED the winner: gemini-1 (zero-intersection), which
 * had the fewest premature-collapse (recall) failures (D-08/D-09). The rule now defaults to
 * the zero-intersection shape (see DEFAULT_PARAMS in active-tag-set.ts): a box stays live
 * while ANY of its topics overlap the active set and collapses only on an empty intersection
 * past the dwell. Do not scatter these numbers elsewhere; import from here.
 */

/**
 * LOCKED (Phase 4 — gemini-1). Size of the recency window: the active-tag set is the
 * union of broad tags over the last N captured non-noise turns.
 */
export const ACTIVE_WINDOW_TURNS = 12;

/**
 * LOCKED (Phase 4 — gemini-1). Zero-intersection dwell: a collapse-eligible box (its topics no
 * longer overlap the active set at all) only actually collapses after its most recent owned
 * turn is at least this many non-noise turns behind the conversation head. A manual expand
 * bumps the box's last-active head, so the same dwell protects an operator override until the
 * topic genuinely moves on.
 */
export const COLLAPSE_DWELL_TURNS = 5;

/**
 * LOCKED (Phase 4 — gemini-1). Cardinality floor: collapse decisions are suppressed until
 * the active-tag set holds at least this many distinct tags, so a single short topic
 * burst cannot collapse everything around it.
 */
export const ACTIVE_SET_CARDINALITY_FLOOR = 2;

/**
 * TUNABLE (Phase 4 — §16). Cheap online segmentation keeps a span open while
 * lexical topic overlap stays at or above this cutoff.
 */
export const SEGMENT_TOPIC_SIMILARITY_CUTOFF = 0.25;

/**
 * TUNABLE (Phase 4 — §16). Number of salient tokens used in the provisional
 * normalized topic label before the tag-DAG slice maps labels to durable tags.
 */
export const SEGMENT_TOPIC_TOKEN_LIMIT = 1;

/**
 * TUNABLE (Phase 5 — TUNE-02; spec §7). Additive importance weights for the
 * dreaming enrichment score `w_r·norm(recurrence) + w_d·log(1+turn_depth) + w_e·effort`.
 * Shipped as the spec defaults 0.4/0.3/0.3 (sum 1.0); Phase-5 stores the raw inputs so
 * TUNE-02 can retune these against held-out spike boxes without re-deriving the score.
 * Additive axes keep a recurrence=1 / high-effort thread from being zeroed (D11).
 */
export const IMPORTANCE_WEIGHT_RECURRENCE = 0.4;
export const IMPORTANCE_WEIGHT_DEPTH = 0.3;
export const IMPORTANCE_WEIGHT_EFFORT = 0.3;

/**
 * TUNABLE (Phase 5 — §7 normalization curve). Saturating half-saturation constant for the
 * recurrence axis: `norm(recurrence) = recurrence / (recurrence + k)`. With k the axis is
 * monotonic but bounded in [0,1), so an unbounded recurrence count cannot dominate the
 * score regardless of the weight. k is the recurrence count at which the axis reaches 0.5.
 */
export const IMPORTANCE_RECURRENCE_HALF_SATURATION = 3;

/**
 * TUNABLE (Phase 5 — §7/§13 bounded deep-pass). Per-night caps for the dreaming enrichment
 * producer so the pass cannot run unbounded as the graph grows: at most this many boxes are
 * enriched, and at most this many DAG parent edges are linked, per invocation. Enrichment is
 * idempotent, so a capped run simply resumes uncovered boxes on the next night.
 */
export const ENRICHMENT_MAX_BOXES_PER_NIGHT = 200;
export const ENRICHMENT_MAX_TAG_EDGES_PER_NIGHT = 100;

/**
 * TUNABLE (Phase 5 — §7 deep DAG). Minimum co-occurrence weight (shared durable targets)
 * before the enrichment pass proposes a broader/narrower tag DAG parent edge. A parent must
 * additionally co-occur across the child's whole shared-target set and span strictly more
 * targets, so this floor need only require genuine (non-empty) co-occurrence; the structural
 * broader-than test is what keeps the graph from over-connecting (recall-safety-first).
 */
export const ENRICHMENT_MIN_COOCCURRENCE_WEIGHT = 1;

/** TUNABLE (Phase 5). Max non-noise turns folded into one box rollup summary. */
export const ENRICHMENT_ROLLUP_MAX_TURNS = 6;

/** TUNABLE (Phase 5). Max characters per rollup summary (bounded, local heuristic). */
export const ENRICHMENT_ROLLUP_MAX_CHARS = 600;

/**
 * TUNABLE (Phase 5 — TUNE-02; spec §6.4/§9 conservative strong-match auto-expand). The
 * retrieval-match score (normalized token overlap between the turn query and an indexed
 * box/entity/tag rollup, [0,1]) at or above which the accordion-aware query mode auto-expands
 * the matched collapsed box for the current turn. Shipped as a deliberately CONSERVATIVE default
 * (strong-match only, recall-safety-first D-07/D-09): a weak/near-threshold match must NOT
 * auto-expand — better to leave a box collapsed than to surface the wrong old matter. The
 * replay precision/recall harness (05-05) retunes this against held-out data.
 */
export const ACCORDION_STRONG_MATCH_CUTOFF = 0.6;
