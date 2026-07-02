// 05-04 Task 2: conservative strong-match retrieval auto-expand decision. A strong match
// (score ≥ cutoff) resolves to expanding the matched collapsed box; a weak match does not and
// there is NO silent fallback. The decision is PURE — it mutates no shared state. Decisions are
// logged with their score.
import type { AssociativeContext } from "openclaw/plugin-sdk/memory-core-host-associative";
import { describe, expect, it } from "vitest";
import { resolveRetrievalAutoExpand } from "./accordion-auto-expand.js";
import {
  ACCORDION_STRONG_MATCH_CUTOFF,
  ACCORDION_SUPPRESSION_CUTOFF_BUMP,
} from "./accordion-constants.js";

function context(boxes: Partial<AssociativeContext["boxes"][number]>[]): AssociativeContext {
  return {
    boxes: boxes.map((box) => ({
      boxId: box.boxId ?? "box",
      topic: box.topic ?? null,
      summary: box.summary ?? null,
      state: box.state ?? "collapsed",
      tags: box.tags ?? [],
      entities: box.entities ?? [],
      importance: box.importance ?? null,
      summaryEmbeddingRef: box.summaryEmbeddingRef ?? null,
      suppressionRollup: box.suppressionRollup ?? null,
    })),
  };
}

const scope = { agentId: "a", sessionKey: "agent:a:main" };

describe("resolveRetrievalAutoExpand", () => {
  it("expands a collapsed box on a strong match", () => {
    const decision = resolveRetrievalAutoExpand({
      query: "what did we decide on the Fidel litigation strategy",
      context: context([
        {
          boxId: "b1",
          topic: "Fidel litigation strategy",
          summary: "Fidel litigation strategy rollup",
          entities: ["Fidel"],
        },
      ]),
      ...scope,
    });
    expect(decision.expanded).toBe(true);
    expect(decision.boxId).toBe("b1");
    expect(decision.score).toBeGreaterThanOrEqual(ACCORDION_STRONG_MATCH_CUTOFF);
  });

  it("does NOT expand on a weak/near-threshold match (conservative, strong-match only)", () => {
    const decision = resolveRetrievalAutoExpand({
      query: "the weather forecast for tomorrow",
      context: context([
        {
          boxId: "b1",
          topic: "Fidel litigation",
          summary: "Fidel litigation rollup",
          entities: ["Fidel"],
        },
      ]),
      ...scope,
    });
    expect(decision.expanded).toBe(false);
    expect(decision.score).toBeLessThan(ACCORDION_STRONG_MATCH_CUTOFF);
  });

  it("is PURE: repeated calls do not mutate shared state (safe to replay)", () => {
    // Regression for the deleted process-global injectedThisTurn map: resolving a strong match,
    // then a weak one for the same scope, must not let the first call leak into the second.
    const strongContext = context([
      { boxId: "b1", topic: "Fidel litigation strategy", entities: ["Fidel"] },
    ]);
    const first = resolveRetrievalAutoExpand({
      query: "the Fidel litigation strategy",
      context: strongContext,
      ...scope,
    });
    const second = resolveRetrievalAutoExpand({
      query: "the stock market rally continued",
      context: context([{ boxId: "b2", topic: "weather forecast tomorrow", entities: [] }]),
      ...scope,
    });
    // Re-running the exact first call yields an identical decision — no accumulated state.
    const firstAgain = resolveRetrievalAutoExpand({
      query: "the Fidel litigation strategy",
      context: strongContext,
      ...scope,
    });
    expect(first.expanded).toBe(true);
    expect(second.expanded).toBe(false);
    expect(second.boxId).toBeNull();
    expect(firstAgain).toEqual(first);
  });

  it("only considers collapsed boxes (a live box is already in context)", () => {
    const decision = resolveRetrievalAutoExpand({
      query: "Fidel litigation strategy rollup",
      context: context([
        {
          boxId: "live1",
          topic: "Fidel litigation strategy",
          summary: "Fidel litigation strategy rollup",
          state: "live",
        },
      ]),
      ...scope,
    });
    expect(decision.expanded).toBe(false);
    expect(decision.boxId).toBeNull();
  });

  it("returns no-expand (not a downgraded query) when the store is empty — no silent fallback", () => {
    const decision = resolveRetrievalAutoExpand({
      query: "anything",
      context: context([]),
      ...scope,
    });
    expect(decision.expanded).toBe(false);
    expect(decision.boxId).toBeNull();
    expect(decision.score).toBe(0);
  });

  it("records the winning box's indexRef (05-06) in the decision", () => {
    const decision = resolveRetrievalAutoExpand({
      query: "Fidel litigation strategy rollup",
      context: context([
        {
          boxId: "b1",
          topic: "Fidel litigation strategy",
          summary: "Fidel litigation strategy rollup",
          summaryEmbeddingRef: "rollup:b1:cafe",
        },
      ]),
      ...scope,
    });
    expect(decision.expanded).toBe(true);
    expect(decision.indexRef).toBe("rollup:b1:cafe");
    expect(decision.suppressed).toBe(false);
  });

  // A low-salience (suppressed) box needs a HIGHER effective cutoff on a lexical-only match:
  // the same coarse overlap that would expand a normal box must not surface a suppressed topic.
  const suppressibleQuery = "alpha bravo";
  const suppressibleTopic = "alpha bravo charlie"; // overlap 2/3 ≈ 0.667: ≥ base cutoff, < bumped

  it("expands a lexical-only match against a NON-suppressed box (control)", () => {
    const decision = resolveRetrievalAutoExpand({
      query: suppressibleQuery,
      context: context([{ boxId: "n", topic: suppressibleTopic }]),
      ...scope,
    });
    expect(decision.expanded).toBe(true);
    expect(decision.boxId).toBe("n");
    expect(decision.score).toBeGreaterThanOrEqual(ACCORDION_STRONG_MATCH_CUTOFF);
    expect(decision.score).toBeLessThan(
      ACCORDION_STRONG_MATCH_CUTOFF + ACCORDION_SUPPRESSION_CUTOFF_BUMP,
    );
  });

  it("requires the higher effective cutoff for a suppressed box on a lexical-only match", () => {
    const decision = resolveRetrievalAutoExpand({
      query: suppressibleQuery,
      context: context([
        {
          boxId: "s",
          topic: suppressibleTopic,
          suppressionRollup: "suppressed:alpha:low-salience",
        },
      ]),
      ...scope,
    });
    // Same overlap that expanded the control box does NOT clear the raised bar.
    expect(decision.expanded).toBe(false);
    expect(decision.boxId).toBeNull();
  });

  it("NEVER suppresses an exact-entity mention — a precise reference to a suppressed topic still auto-expands (recall-safety-first, D-07/D-09)", () => {
    const decision = resolveRetrievalAutoExpand({
      query: "what about Fidel",
      context: context([
        {
          boxId: "f",
          topic: suppressibleTopic,
          entities: ["Fidel"],
          suppressionRollup: "suppressed:alpha:low-salience",
          summaryEmbeddingRef: "rollup:f:99",
        },
      ]),
      ...scope,
    });
    expect(decision.expanded).toBe(true);
    expect(decision.boxId).toBe("f");
    // The exact-entity mention overrode suppression — the raised cutoff was NOT applied.
    expect(decision.suppressed).toBe(false);
    expect(decision.indexRef).toBe("rollup:f:99");
  });
});
