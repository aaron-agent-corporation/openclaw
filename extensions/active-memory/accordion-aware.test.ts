// 05-04 Task 2: accordion-aware queryMode. On a strong match the mode escalates to
// auto-expand (calls the write-seam auto-expand, marks injectedThisTurn) and logs the decision;
// a weak match does neither; there is NO silent fallback to a weaker query.
import { describe, expect, it, vi } from "vitest";
import {
  ACCORDION_AWARE_QUERY_MODE,
  isAccordionAwareQueryMode,
  runAccordionAwareAutoExpand,
} from "./accordion-aware.js";

const context = {
  boxes: [
    {
      boxId: "b1",
      topic: "Fidel",
      summary: "s",
      state: "collapsed" as const,
      tags: [],
      entities: ["Fidel"],
      importance: 0.5,
      summaryEmbeddingRef: null,
      suppressionRollup: null,
    },
  ],
};

function seams(expanded: boolean, score: number) {
  const decision = {
    boxId: expanded ? "b1" : null,
    score,
    cutoff: 0.6,
    expanded,
    indexRef: expanded ? "rollup:b1:abc" : null,
    suppressed: false,
  };
  const applyRetrievalAutoExpand = vi.fn(() => ({ decision, log: decision }));
  const injectedThisTurnBoxIds = vi.fn(() => (expanded ? ["b1"] : []));
  return {
    readAssociativeContext: vi.fn(() => context),
    applyRetrievalAutoExpand,
    injectedThisTurnBoxIds,
    logDecision: vi.fn(),
  };
}

describe("accordion-aware queryMode", () => {
  it("exposes the additive 4th queryMode value and recognizes it", () => {
    expect(ACCORDION_AWARE_QUERY_MODE).toBe("accordion-aware");
    expect(isAccordionAwareQueryMode("accordion-aware")).toBe(true);
    expect(isAccordionAwareQueryMode("recent")).toBe(false);
  });

  it("escalates to auto-expand on a strong match and logs the decision", () => {
    const s = seams(true, 0.8);
    const out = runAccordionAwareAutoExpand({
      agentId: "a",
      sessionKey: "agent:a:main",
      query: "the Fidel matter",
      ...s,
    });
    expect(s.applyRetrievalAutoExpand).toHaveBeenCalledOnce();
    expect(out.expanded).toBe(true);
    expect(out.expandedBoxIds).toEqual(["b1"]);
    // Decision (score + expand/no-expand) is logged (§13).
    expect(s.logDecision).toHaveBeenCalledWith(
      expect.objectContaining({ expanded: true, score: 0.8 }),
    );
  });

  it("does not expand or mark injectedThisTurn on a weak match", () => {
    const s = seams(false, 0.2);
    const out = runAccordionAwareAutoExpand({
      agentId: "a",
      sessionKey: "agent:a:main",
      query: "weather",
      ...s,
    });
    expect(out.expanded).toBe(false);
    expect(out.expandedBoxIds).toEqual([]);
    expect(s.logDecision).toHaveBeenCalledWith(
      expect.objectContaining({ expanded: false, score: 0.2 }),
    );
  });

  it("has NO silent fallback: an empty/weak result never re-queries a weaker mode", () => {
    const s = seams(false, 0);
    // Only the accordion-aware auto-expand seam is provided. If the code silently
    // fell back to message/recent it would need a different query path — there is none.
    const out = runAccordionAwareAutoExpand({
      agentId: "a",
      sessionKey: "agent:a:main",
      query: "nothing relevant",
      ...s,
    });
    expect(out.fellBackToWeakerMode).toBe(false);
    // readAssociativeContext + the single auto-expand decision are the only retrieval calls.
    expect(s.applyRetrievalAutoExpand).toHaveBeenCalledOnce();
  });
});
