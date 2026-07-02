// 05-04 Task 1: box/entity/tag-rollup summaries produced by the 05-03 dreaming pass become
// retrievable indexed records (no second memory slot — projected from the existing associative
// read seam), and re-ranking weights hits by importance + exact entity-key matches.
import type { AssociativeContext } from "openclaw/plugin-sdk/memory-core-host-associative";
import { describe, expect, it } from "vitest";
import { buildAssociativeIndexRecords, entityKeysFromContext } from "./associative-index.js";
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

describe("buildAssociativeIndexRecords", () => {
  it("projects box + entity + tag rollup summaries into retrievable records with importance", () => {
    const records = buildAssociativeIndexRecords(
      context([
        {
          boxId: "b1",
          topic: "Fidel case",
          summary: "Rollup of the Fidel litigation strategy.",
          entities: ["Fidel"],
          tags: ["litigation"],
          importance: 0.8,
        },
      ]),
    );
    // box rollup + entity summary + tag rollup are all retrievable.
    const kinds = records.map((r) => r.kind).sort();
    expect(kinds).toEqual(["box", "entity", "tag"]);
    const box = records.find((r) => r.kind === "box");
    expect(box?.importance).toBe(0.8);
    expect(box?.boxId).toBe("b1");
    expect(box?.text).toContain("Fidel");
  });

  it("carries the box summary_embedding_ref as indexRef and topic/tags as recallKeys", () => {
    const records = buildAssociativeIndexRecords(
      context([
        {
          boxId: "b1",
          topic: "Fidel case",
          summary: "Rollup of the Fidel litigation strategy.",
          entities: ["Fidel"],
          tags: ["litigation"],
          summaryEmbeddingRef: "rollup:b1:deadbeef",
        },
      ]),
    );
    // Every record projected from the box pins the exact enriched-rollup version it matched.
    for (const record of records) {
      expect(record.indexRef).toBe("rollup:b1:deadbeef");
      expect(record.recallKeys).toEqual(["fidel case", "litigation"]);
      expect(record.entityKeys).toEqual(["fidel"]);
    }
  });

  it("indexes a topic-only box (not-yet-summarized) so its topic recall key survives", () => {
    const records = buildAssociativeIndexRecords(context([{ boxId: "t", topic: "Fidel case" }]));
    expect(records.map((r) => r.kind)).toEqual(["box"]);
    expect(records[0]?.text).toBe("Fidel case");
    expect(records[0]?.recallKeys).toEqual(["fidel case"]);
    expect(records[0]?.indexRef).toBeNull();
  });

  it("returns no records for an empty associative store (no second slot to populate)", () => {
    expect(buildAssociativeIndexRecords(context([]))).toEqual([]);
  });

  it("skips boxes with no rollup summary and no labels (nothing to index)", () => {
    expect(buildAssociativeIndexRecords(context([{ boxId: "empty" }]))).toEqual([]);
  });
});

describe("augmentMemoryResultsWithAssociativeContext — importance + entity-key weighting", () => {
  it("ranks an exact entity-key match above a coarse semantic-only hit", () => {
    const results: Hit[] = [
      // Higher raw score but only a coarse topic-word overlap.
      { id: "coarse", snippet: "notes about a court case in general", score: 0.6 },
      // Lower raw score but an exact entity-key mention.
      { id: "exact", snippet: "update on the Fidel matter", score: 0.5 },
    ];
    const out = augmentMemoryResultsWithAssociativeContext({
      results,
      context: context([{ topic: "court case", entities: ["Fidel"], importance: 0.5 }]),
    });
    expect(out[0].id).toBe("exact");
  });

  it("ranks a higher-importance box above a lower-importance near-tie", () => {
    const results: Hit[] = [
      { id: "low", snippet: "mentions Aurora", score: 0.5 },
      { id: "high", snippet: "mentions Borealis", score: 0.5 },
    ];
    const out = augmentMemoryResultsWithAssociativeContext({
      results,
      context: context([
        { boxId: "lo", entities: ["Aurora"], importance: 0.1 },
        { boxId: "hi", entities: ["Borealis"], importance: 0.9 },
      ]),
    });
    expect(out[0].id).toBe("high");
  });

  it("is a no-op when the associative store is empty (ordering unchanged)", () => {
    const results: Hit[] = [
      { id: "a", snippet: "alpha", score: 0.5 },
      { id: "b", snippet: "beta", score: 0.4 },
    ];
    const out = augmentMemoryResultsWithAssociativeContext({ results, context: context([]) });
    expect(out.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("does not mutate the input results", () => {
    const results: Hit[] = [{ id: "a", snippet: "the Fidel matter", score: 0.4 }];
    const snapshot = results.map((r) => ({ ...r }));
    augmentMemoryResultsWithAssociativeContext({
      results,
      context: context([{ entities: ["Fidel"], importance: 0.5 }]),
    });
    expect(results).toEqual(snapshot);
  });
});

describe("entityKeysFromContext", () => {
  it("collects distinct lowercased entity keys", () => {
    expect(
      entityKeysFromContext(context([{ entities: ["Fidel", "fidel", "Aurora"] }])).sort(),
    ).toEqual(["aurora", "fidel"]);
  });
});
