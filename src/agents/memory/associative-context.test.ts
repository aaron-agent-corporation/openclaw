// 03-04 read-only associative context facade: the compact box+tags+entities view the
// memory-core seam consumes. Built end-to-end from the segmentation/tag/entity producers.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { associateConversationEntities } from "./associate-entities.js";
import { associateSegmentationTopics } from "./associate-topics.js";
import { readAssociativeContext, readBoxRollupInputs } from "./associative-context.js";
import { segmentConversationTurns } from "./segment-spans.js";
import { appendTurns, type NewTurn } from "./turns-store.js";

function scope(stateDir: string) {
  return {
    agentId: "main",
    sessionKey: "agent:main:main",
    env: { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv,
  };
}

function turn(idempotencyKey: string, content: string): NewTurn {
  return { role: "user", content, contentHash: `hash-${idempotencyKey}`, idempotencyKey, ts: 1 };
}

function roleTurn(idempotencyKey: string, role: string, content: string): NewTurn {
  return { role, content, contentHash: `hash-${idempotencyKey}`, idempotencyKey, ts: 1 };
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

describe("readAssociativeContext", () => {
  it("returns a fresh empty result each call, so mutating one does not leak into the next", () => {
    const s = scope(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-assoc-context-")));
    const first = readAssociativeContext(s);
    expect(first).toEqual({ boxes: [] });
    // Public read surface: a caller mutating the array must not affect a later empty read.
    first.boxes.push({
      boxId: "x",
      topic: "x",
      summary: null,
      state: "live",
      tags: [],
      entities: [],
      importance: null,
    });
    expect(readAssociativeContext(s)).toEqual({ boxes: [] });
  });

  it("returns each box with its summary, tags, and entities", () => {
    const s = scope(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-assoc-context-")));
    appendTurns({ ...s, turns: [turn("k1", "Met with Acme Corp about the NEBULA-73 rollout")] });
    const segmentation = segmentConversationTurns(s);
    associateSegmentationTopics({ ...s, segmentation });
    associateConversationEntities({ ...s, segmentation });

    const context = readAssociativeContext(s);
    expect(context.boxes).toHaveLength(1);
    const box = context.boxes[0];
    expect(box.topic).toBe("met");
    expect(box.state).toBe("live");
    expect(box.summary && box.summary.length > 0).toBe(true);
    expect(box.tags).toEqual(["met"]);
    expect(box.entities).toEqual(["Acme Corp", "NEBULA-73"]);
  });
});

describe("readBoxRollupInputs", () => {
  it("returns no boxes for an empty store", () => {
    const s = scope(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-rollup-")));
    expect(readBoxRollupInputs(s)).toEqual([]);
  });

  it("exposes a box's non-noise turns plus derived importance axes", () => {
    const s = scope(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-rollup-")));
    // Same-topic user + assistant turns segment into one box; a [SILENT] heartbeat is
    // stored as suppressed noise and must be excluded from depth/rollup.
    appendTurns({
      ...s,
      turns: [
        roleTurn("u1", "user", "migration migration migration database schedule plan"),
        roleTurn("a1", "assistant", "migration migration migration database schedule plan yes"),
        roleTurn("h1", "user", "[SILENT] heartbeat"),
      ],
    });
    const segmentation = segmentConversationTurns(s);
    associateSegmentationTopics({ ...s, segmentation });

    const inputs = readBoxRollupInputs(s);
    // Every returned box exposes its non-noise turns and normalized axes.
    const suppressed = inputs.flatMap((b) => b.turns).some((t) => t.content.includes("[SILENT]"));
    expect(suppressed).toBe(false);
    for (const box of inputs) {
      expect(box.turnDepth).toBe(box.turns.length);
      expect(box.recurrenceCount).toBeGreaterThanOrEqual(1);
      expect(box.effortSignal).toBeGreaterThanOrEqual(0);
      expect(box.effortSignal).toBeLessThanOrEqual(1);
    }
    // The whole non-noise transcript (2 turns) is owned across the returned boxes.
    const totalDepth = inputs.reduce((sum, box) => sum + box.turnDepth, 0);
    expect(totalDepth).toBe(2);
    // At least one box carries an assistant (effort) turn.
    const hasEffort = inputs.some((box) => box.effortSignal > 0);
    expect(hasEffort).toBe(true);
  });
});
