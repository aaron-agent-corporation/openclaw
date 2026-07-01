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
