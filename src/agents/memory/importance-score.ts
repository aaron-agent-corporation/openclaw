/**
 * Additive, fully-normalized box importance (Phase 5 — DREAM-01; spec §7).
 *
 *   importance = w_r·norm(recurrence) + w_d·norm(log(1 + turn_depth)) + w_e·effort_signal
 *
 * Every axis is normalized to [0,1] so an unbounded recurrence or turn-depth cannot
 * dominate regardless of weights, and the additive shape keeps a recurrence=1 /
 * high-effort thread scoring meaningfully instead of being zeroed (D11). Weights live on
 * the single `accordion-constants.ts` tunable surface (TUNE-02). The raw inputs are echoed
 * back so a producer can store them and TUNE-02 can retune weights without re-deriving.
 *
 * Pure and dependency-free: no I/O, no store access, no clock. The dreaming enrichment
 * producer derives the inputs from a box's turns/spans and feeds them here.
 */
import {
  IMPORTANCE_RECURRENCE_HALF_SATURATION,
  IMPORTANCE_WEIGHT_DEPTH,
  IMPORTANCE_WEIGHT_EFFORT,
  IMPORTANCE_WEIGHT_RECURRENCE,
} from "./accordion-constants.js";

/** Raw importance inputs derived from a box; stored verbatim for TUNE-02 retuning. */
export type ImportanceInputs = {
  /** How many times the box's topic recurred (distinct owning spans / re-visits). */
  recurrenceCount: number;
  /** Conversational depth of the box (non-noise turns it owns). */
  turnDepth: number;
  /** Effort signal in [0,1] (tool usage / user engagement density for the box). */
  effortSignal: number;
};

export type ImportanceResult = {
  /** Normalized additive score in [0,1]. */
  score: number;
  /** The raw inputs, echoed so they can be persisted alongside the score. */
  inputs: ImportanceInputs;
};

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value >= 1 ? 1 : value;
}

/**
 * Saturating recurrence normalization `n / (n + k)`: monotonic non-decreasing, bounded in
 * [0,1), so no recurrence count can reach the axis ceiling of 1 (and thus cannot dominate
 * the weighted sum). k (`IMPORTANCE_RECURRENCE_HALF_SATURATION`) is the count at which the
 * axis hits 0.5.
 */
function normalizeRecurrence(recurrenceCount: number): number {
  const n = Number.isFinite(recurrenceCount) ? Math.max(0, recurrenceCount) : 0;
  const k = IMPORTANCE_RECURRENCE_HALF_SATURATION;
  return n / (n + k);
}

/**
 * Depth axis: `log(1 + turn_depth)` per §7, squashed to [0,1) via the same saturating
 * curve so an unbounded transcript cannot dominate. Half-saturation matches the recurrence
 * constant in log-space, keeping both axes on a comparable scale.
 */
function normalizeDepth(turnDepth: number): number {
  const depth = Number.isFinite(turnDepth) ? Math.max(0, turnDepth) : 0;
  const logDepth = Math.log(1 + depth);
  const k = Math.log(1 + IMPORTANCE_RECURRENCE_HALF_SATURATION);
  return logDepth / (logDepth + k);
}

/** Compute the normalized additive importance score and echo the raw inputs. */
export function computeImportance(inputs: ImportanceInputs): ImportanceResult {
  const recurrence = normalizeRecurrence(inputs.recurrenceCount);
  const depth = normalizeDepth(inputs.turnDepth);
  const effort = clamp01(inputs.effortSignal);
  const score =
    IMPORTANCE_WEIGHT_RECURRENCE * recurrence +
    IMPORTANCE_WEIGHT_DEPTH * depth +
    IMPORTANCE_WEIGHT_EFFORT * effort;
  return { score: clamp01(score), inputs };
}
