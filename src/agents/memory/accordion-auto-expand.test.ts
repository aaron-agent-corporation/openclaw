// 05-04 Task 2: conservative strong-match retrieval auto-expand decision. A strong match
// (score ≥ cutoff) expands the matched collapsed box and marks it injectedThisTurn; a weak
// match does neither and there is NO silent fallback. Decisions are logged with their score.
import type { AssociativeContext } from "openclaw/plugin-sdk/memory-core-host-associative";
import { describe, expect, it, beforeEach } from "vitest";
import {
  clearInjectedThisTurn,
  injectedThisTurnBoxIds,
  resolveRetrievalAutoExpand,
} from "./accordion-auto-expand.js";
import { ACCORDION_STRONG_MATCH_CUTOFF } from "./accordion-constants.js";

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
    })),
  };
}

const scope = { agentId: "a", sessionKey: "agent:a:main" };

describe("resolveRetrievalAutoExpand", () => {
  beforeEach(() => clearInjectedThisTurn(scope));

  it("expands a collapsed box on a strong match and marks it injectedThisTurn", () => {
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
    expect(injectedThisTurnBoxIds(scope)).toContain("b1");
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
    expect(injectedThisTurnBoxIds(scope)).toHaveLength(0);
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
});
