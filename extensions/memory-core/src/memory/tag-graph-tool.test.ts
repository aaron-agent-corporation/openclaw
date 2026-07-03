// Agent-navigable tag co-occurrence tool: wires the read-only readTagCooccurrence
// seam into a memory-core tool so an agent can hop the tag graph as ranked lists.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  associateEnrichmentTag,
  upsertEnrichmentTag,
} from "openclaw/plugin-sdk/memory-core-host-associative-write";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it } from "vitest";
import { createTagGraphTool } from "./tag-graph-tool.js";

const AGENT_ID = "main";
const SESSION_KEY = "agent:main:main";

function tempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-tag-graph-tool-"));
}

function seedScope(stateDir: string) {
  return {
    agentId: AGENT_ID,
    env: { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv,
  };
}

function addTag(stateDir: string, tagId: string, label: string): void {
  upsertEnrichmentTag({ ...seedScope(stateDir), tag: { tagId, label } });
}

function tagTarget(
  stateDir: string,
  tagId: string,
  target:
    | { boxId: string; type: "box" }
    | { spanId: string; type: "span" }
    | { seq: number; type: "turn" },
): void {
  associateEnrichmentTag({
    ...seedScope(stateDir),
    source: "dream",
    tagId,
    target: { ...target, sessionKey: SESSION_KEY },
  });
}

function seededStore(): string {
  const stateDir = tempStateDir();
  addTag(stateDir, "tag-lisbon", "Lisbon");
  addTag(stateDir, "tag-travel", "Travel");
  addTag(stateDir, "tag-food", "Food");
  tagTarget(stateDir, "tag-lisbon", { type: "turn", seq: 1 });
  tagTarget(stateDir, "tag-travel", { type: "turn", seq: 1 });
  tagTarget(stateDir, "tag-lisbon", { type: "box", boxId: "box-trip" });
  tagTarget(stateDir, "tag-travel", { type: "box", boxId: "box-trip" });
  tagTarget(stateDir, "tag-lisbon", { type: "span", spanId: "span-dinner" });
  tagTarget(stateDir, "tag-food", { type: "span", spanId: "span-dinner" });
  return stateDir;
}

function buildTool(stateDir: string) {
  const previous = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const tool = createTagGraphTool({ agentId: AGENT_ID, agentSessionKey: SESSION_KEY });
  if (previous == null) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previous;
  }
  if (!tool) {
    throw new Error("tag graph tool was not created");
  }
  return tool;
}

async function callTool(
  tool: ReturnType<typeof buildTool>,
  stateDir: string,
  params: Record<string, unknown>,
): Promise<{ tag: unknown; neighbors: Array<Record<string, unknown>> }> {
  const previous = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  try {
    const result = await tool.execute("call-1", params);
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "{}";
    return JSON.parse(text);
  } finally {
    if (previous == null) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previous;
    }
  }
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

describe("createTagGraphTool", () => {
  it("returns neighbors ranked by descending weight with intersection targets", async () => {
    const stateDir = seededStore();
    const tool = buildTool(stateDir);
    const traversal = await callTool(tool, stateDir, { tag: "lisbon" });

    expect(traversal.tag).toEqual({ tagId: "tag-lisbon", label: "Lisbon" });
    expect(traversal.neighbors.map((n) => [n.tagId, n.weight])).toEqual([
      ["tag-travel", 2],
      ["tag-food", 1],
    ]);
    const travel = traversal.neighbors[0];
    expect(travel?.targets).toEqual([
      { targetType: "box", targetId: "box-trip" },
      { targetType: "turn", targetId: "1" },
    ]);
  });

  it("honors the optional limit argument", async () => {
    const stateDir = seededStore();
    const tool = buildTool(stateDir);
    const traversal = await callTool(tool, stateDir, { tag: "lisbon", limit: 1 });
    expect(traversal.neighbors.map((n) => n.tagId)).toEqual(["tag-travel"]);
  });

  it("returns an empty traversal for an unknown tag", async () => {
    const stateDir = seededStore();
    const tool = buildTool(stateDir);
    const traversal = await callTool(tool, stateDir, { tag: "does-not-exist" });
    expect(traversal).toEqual({ tag: null, neighbors: [] });
  });

  it("returns an empty traversal without throwing on an empty store", async () => {
    const stateDir = tempStateDir();
    const tool = buildTool(stateDir);
    const traversal = await callTool(tool, stateDir, { tag: "anything" });
    expect(traversal).toEqual({ tag: null, neighbors: [] });
  });
});
