/**
 * Recall-safety-first replay objective (Phase 5, 05-05 / D-03; mirrors Phase 4 D-07/D-09). Pure,
 * dependency-free aggregate score for one replay of the accordion-aware auto-expand decisions over
 * backfilled history. Higher is better.
 *
 * The whole point of the accordion is that the agent always has its working memory: wrongly
 * collapsing / failing to surface a still-needed topic (a RECALL failure) is the worst outcome and
 * is penalized hardest. A spurious surface (a PRECISION failure) wastes some context but never
 * loses matter, so it is penalized less. Token savings are only a secondary tie-breaker and — by
 * construction — can never offset a single recall failure.
 *
 * Weight ordering (STRICT): recall failure >> precision failure >> lost token savings.
 * The weights themselves are TUNE-02 territory; this ships a conservative recall-heavy default and
 * caps the savings contribution below one recall penalty so the ordering is provable, not tuned.
 */

/** Per-decision classification tallies plus the net token savings the run achieved. */
export type ReplayEvalCounts = {
  /** Collapsed box correctly LEFT collapsed (not needed this turn). */
  recallCorrect: number;
  /** A still-needed topic wrongly collapsed / not surfaced — the worst outcome (D-03). */
  recallFailures: number;
  /** Collapsed box correctly surfaced when it was needed / correctly not surfaced when spurious. */
  precisionCorrect: number;
  /** A spurious surface: a box expanded that the reference says was not needed. */
  precisionFailures: number;
  /**
   * Net token savings the run achieved by keeping boxes collapsed, in arbitrary units. Positive
   * rewards leaner context; negative represents forgone savings. Secondary tie-breaker only.
   */
  tokenSavings: number;
};

/**
 * Penalty per recall failure. Dominates every other term: it is more than one precision penalty
 * AND more than the entire capped savings contribution, so a single recall failure can never be
 * bought back by precision wins or token savings.
 */
export const RECALL_FAILURE_PENALTY = 1000;

/** Penalty per precision failure. Strictly less than a recall failure, strictly more than savings. */
export const PRECISION_FAILURE_PENALTY = 10;

/**
 * The savings term is squashed into (-1, 1) via a saturating curve and weighted below 1, so the
 * total savings contribution is always strictly smaller than a single precision penalty (10) and
 * far below a single recall penalty (1000). Savings can only order two otherwise-equal runs.
 */
export const SAVINGS_WEIGHT = 1;
const SAVINGS_HALF_SATURATION = 50;

function savingsContribution(tokenSavings: number): number {
  // Saturating sign-preserving squash: monotonic in tokenSavings, bounded in (-1, 1). Guarantees
  // the savings term can never reach even one precision penalty, so ordering stays strict.
  const magnitude = Math.abs(tokenSavings);
  const squashed = magnitude / (magnitude + SAVINGS_HALF_SATURATION);
  return Math.sign(tokenSavings) * squashed * SAVINGS_WEIGHT;
}

/**
 * Aggregate a replay run into a single recall-safety-first score. Correct decisions do not add
 * reward (a clean run scores 0 minus nothing); failures subtract their penalty; savings nudge the
 * tie-breaker within (-1, 1). This keeps the score interpretable: 0 is a perfect run, and every
 * negative unit maps back to a specific failure class.
 */
export function scoreRun(counts: ReplayEvalCounts): number {
  const recallPenalty = counts.recallFailures * RECALL_FAILURE_PENALTY;
  const precisionPenalty = counts.precisionFailures * PRECISION_FAILURE_PENALTY;
  return -recallPenalty - precisionPenalty + savingsContribution(counts.tokenSavings);
}
