// 05-05 Task 1: recall-safety-first replay objective (D-03, mirrors Phase 4 D-07/D-09). A recall
// failure (a still-needed topic wrongly collapsed / not surfaced) must cost strictly more than a
// precision failure (a spurious surface), which must cost strictly more than equivalent lost
// token savings — and no amount of token savings can offset a single recall failure.
import { describe, expect, it } from "vitest";
import { scoreRun, type ReplayEvalCounts } from "./replay-eval-objective.js";

function counts(overrides: Partial<ReplayEvalCounts>): ReplayEvalCounts {
  return {
    recallCorrect: 0,
    recallFailures: 0,
    precisionCorrect: 0,
    precisionFailures: 0,
    tokenSavings: 0,
    ...overrides,
  };
}

describe("scoreRun", () => {
  it("penalizes a recall failure strictly more than a precision failure", () => {
    const oneRecallMiss = scoreRun(counts({ recallFailures: 1 }));
    const onePrecisionMiss = scoreRun(counts({ precisionFailures: 1 }));
    // Higher score is better; a recall failure must drag the score down harder.
    expect(oneRecallMiss).toBeLessThan(onePrecisionMiss);
  });

  it("penalizes a precision failure strictly more than equivalent lost token savings", () => {
    const onePrecisionMiss = scoreRun(counts({ precisionFailures: 1 }));
    // "Equivalent lost savings" = the same unit count expressed as forgone savings.
    const lostOneSaving = scoreRun(counts({ tokenSavings: -1 }));
    expect(onePrecisionMiss).toBeLessThan(lostOneSaving);
  });

  it("scores the run with fewer recall failures better when total errors are equal", () => {
    // Run A: 1 recall + 3 precision failures (4 total). Run B: 2 recall + 2 precision (4 total).
    const runA = scoreRun(counts({ recallFailures: 1, precisionFailures: 3 }));
    const runB = scoreRun(counts({ recallFailures: 2, precisionFailures: 2 }));
    expect(runA).toBeGreaterThan(runB);
  });

  it("cannot offset a single recall failure with any amount of token savings", () => {
    const oneRecallMiss = scoreRun(counts({ recallFailures: 1, tokenSavings: 1_000_000 }));
    const cleanRun = scoreRun(counts({ recallCorrect: 5, precisionCorrect: 5 }));
    // Even huge savings cannot lift a run that dropped a needed topic above a clean run.
    expect(oneRecallMiss).toBeLessThan(cleanRun);
  });

  it("uses token savings only as a secondary tie-breaker between equal-error runs", () => {
    const savingsHigh = scoreRun(counts({ precisionFailures: 1, tokenSavings: 100 }));
    const savingsLow = scoreRun(counts({ precisionFailures: 1, tokenSavings: 10 }));
    expect(savingsHigh).toBeGreaterThan(savingsLow);
  });
});
