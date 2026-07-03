// 03-04 read-only associative ranking: boost memory hits that mention a known recall
// key (topic/tag/entity), re-sort, never mutate inputs, no-op on empty context.
import type { AssociativeContext } from "openclaw/plugin-sdk/memory-core-host-associative";
import { describe, expect, it } from "vitest";
import { augmentMemoryResultsWithAssociativeContext } from "./associative-ranking.js";

type Hit = { snippet: string; score: number; id: string };

function context(boxes: Partial<AssociativeContext["boxes"][number]>[]): AssociativeContext {
  return {
    boxes: boxes.map((box) => ({
      boxId: box.boxId ?? "box",
      topic: box.topic ?? null,
      summary: box.summary ?? null,
      state: box.state ?? "live",
      tags: box.tags ?? [],
      entities: box.entities ?? [],
      importance: box.importance ?? null,
      summaryEmbeddingRef: box.summaryEmbeddingRef ?? null,
      suppressionRollup: box.suppressionRollup ?? null,
    })),
  };
}

describe("augmentMemoryResultsWithAssociativeContext", () => {
  const results: Hit[] = [
    { id: "a", snippet: "general note about scheduling", score: 0.5 },
    { id: "b", snippet: "follow up on the NEBULA-73 invoice", score: 0.4 },
  ];

  it("boosts a hit mentioning a recall entity above a higher-scored unrelated hit", () => {
    const out = augmentMemoryResultsWithAssociativeContext({
      results,
      context: context([{ entities: ["NEBULA-73"] }]),
      boost: 0.5, // 0.4 * 1.5 = 0.6 > 0.5
    });
    expect(out.map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("is a no-op when the context has no recall keys", () => {
    const out = augmentMemoryResultsWithAssociativeContext({ results, context: context([]) });
    expect(out.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("ignores keys shorter than the minimum length", () => {
    const out = augmentMemoryResultsWithAssociativeContext({
      results,
      context: context([{ tags: ["of"] }]),
      boost: 0.9,
    });
    expect(out.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("returns each matched hit carrying its boosted score (survives a later score read)", () => {
    const out = augmentMemoryResultsWithAssociativeContext({
      results,
      context: context([{ entities: ["NEBULA-73"] }]),
      boost: 0.5,
      entityBoost: 0.5,
    });
    // The matched hit's score is boosted on the returned object, not just reordered: 0.4*1.5=0.6.
    const boosted = out.find((r) => r.id === "b");
    const untouched = out.find((r) => r.id === "a");
    expect(boosted?.score).toBeCloseTo(0.6, 10);
    expect(untouched?.score).toBe(0.5);
    // A downstream re-sort by the returned score keeps the associative ordering.
    const resorted = out.toSorted((x, y) => y.score - x.score);
    expect(resorted.map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("does not mutate the input results", () => {
    const snapshot = results.map((r) => ({ ...r }));
    augmentMemoryResultsWithAssociativeContext({
      results,
      context: context([{ entities: ["NEBULA-73"] }]),
      boost: 0.5,
    });
    expect(results).toEqual(snapshot);
  });
});
