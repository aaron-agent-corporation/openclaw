import { describe, expect, it } from "vitest";
import {
  IMPORTANCE_WEIGHT_DEPTH,
  IMPORTANCE_WEIGHT_EFFORT,
  IMPORTANCE_WEIGHT_RECURRENCE,
} from "./accordion-constants.js";
import { computeImportance } from "./importance-score.js";

describe("computeImportance", () => {
  it("returns a score within [0,1] for varied inputs", () => {
    const cases = [
      { recurrenceCount: 0, turnDepth: 0, effortSignal: 0 },
      { recurrenceCount: 1, turnDepth: 4, effortSignal: 0.5 },
      { recurrenceCount: 50, turnDepth: 200, effortSignal: 1 },
      { recurrenceCount: 1000, turnDepth: 5000, effortSignal: 1 },
    ];
    for (const inputs of cases) {
      const { score } = computeImportance(inputs);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it("is additive: a high-effort recurrence=1 thread out-scores a zero-effort recurrence=1 thread", () => {
    const highEffort = computeImportance({
      recurrenceCount: 1,
      turnDepth: 6,
      effortSignal: 1,
    }).score;
    const zeroEffort = computeImportance({
      recurrenceCount: 1,
      turnDepth: 6,
      effortSignal: 0,
    }).score;
    // Additive axes: effort contributes on its own, so the score is not zeroed by low recurrence.
    expect(highEffort).toBeGreaterThan(zeroEffort);
    expect(highEffort).toBeGreaterThan(0);
  });

  it("recurrence axis is monotonic but saturating (large counts cannot dominate)", () => {
    const base = { turnDepth: 0, effortSignal: 0 };
    const low = computeImportance({ ...base, recurrenceCount: 1 }).score;
    const mid = computeImportance({ ...base, recurrenceCount: 10 }).score;
    const high = computeImportance({ ...base, recurrenceCount: 1_000_000 }).score;
    // Monotonic non-decreasing.
    expect(mid).toBeGreaterThanOrEqual(low);
    expect(high).toBeGreaterThanOrEqual(mid);
    // Saturating: even an unbounded recurrence cannot push the recurrence-only score
    // to (or past) its weight ceiling, so it cannot dominate regardless of the weight.
    expect(high).toBeLessThan(IMPORTANCE_WEIGHT_RECURRENCE);
  });

  it("echoes the raw inputs so they can be stored for retune-without-re-derive", () => {
    const inputs = { recurrenceCount: 3, turnDepth: 9, effortSignal: 0.7 };
    const result = computeImportance(inputs);
    expect(result.inputs).toEqual(inputs);
  });

  it("weights sum to 1 so a fully-saturated thread approaches 1", () => {
    expect(
      IMPORTANCE_WEIGHT_RECURRENCE + IMPORTANCE_WEIGHT_DEPTH + IMPORTANCE_WEIGHT_EFFORT,
    ).toBeCloseTo(1, 10);
    // Very large recurrence + deep + max effort saturates all three axes toward their weights.
    const { score } = computeImportance({
      recurrenceCount: 1_000_000,
      turnDepth: 1_000_000,
      effortSignal: 1,
    });
    expect(score).toBeGreaterThan(0.95);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("clamps out-of-range effort and negative inputs into the normalized axes", () => {
    const { score } = computeImportance({
      recurrenceCount: -5,
      turnDepth: -10,
      effortSignal: 5,
    });
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});
