// Dreaming enrichment producer: reads the per-agent turns/spans/boxes store and writes,
// via the 05-01 write seam, a real rollup summary + normalized importance + DAG parent
// edges. Bounded, idempotent, decision-logged, local-only (§13).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  associateEnrichmentTag,
  listEnrichmentTagEdges,
  upsertEnrichmentTag,
} from "openclaw/plugin-sdk/memory-core-host-associative-write";
import {
  appendTurns,
  listBoxes,
  upsertBox,
  upsertSpan,
  type NewTurn,
} from "openclaw/plugin-sdk/memory-core-host-store-testing";
import { readMemoryHostEventRecords } from "openclaw/plugin-sdk/memory-host-events";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAssociativeEnrichment } from "./dreaming-enrichment.js";

const AGENT_ID = "main";
const SESSION_KEY = "agent:main:main";

function tempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-enrich-"));
}

function seedScope(stateDir: string) {
  return { agentId: AGENT_ID, env: { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv };
}

function turn(seqTag: string, role: string, content: string): NewTurn {
  return { role, content, contentHash: `h-${seqTag}`, idempotencyKey: `k-${seqTag}`, ts: 1 };
}

/**
 * Seed a realistic store: two topic boxes, each owning a multi-turn span, plus a shared
 * tag co-occurrence so the DAG derivation has a broader/narrower candidate. Returns the
 * workspace/state dir.
 */
function seededStore(): string {
  const stateDir = tempStateDir();
  const scope = seedScope(stateDir);
  appendTurns({
    ...scope,
    sessionKey: SESSION_KEY,
    turns: [
      turn("1", "user", "Let us plan the database migration rollout and its schedule"),
      turn("2", "assistant", "Here is a three-phase migration plan with rollback steps"),
      turn("3", "user", "What about the payment provider integration timeline"),
      turn("4", "assistant", "The payment provider integration needs webhook signing first"),
    ],
  });
  upsertBox({
    ...scope,
    box: { boxId: "box-migration", sessionKey: SESSION_KEY, label: "migration" },
  });
  upsertBox({ ...scope, box: { boxId: "box-payment", sessionKey: SESSION_KEY, label: "payment" } });
  upsertSpan({
    ...scope,
    span: {
      spanId: "span-mig",
      sessionKey: SESSION_KEY,
      startSeq: 1,
      endSeq: 2,
      topic: "migration",
      boxId: "box-migration",
    },
  });
  upsertSpan({
    ...scope,
    span: {
      spanId: "span-pay",
      sessionKey: SESSION_KEY,
      startSeq: 3,
      endSeq: 4,
      topic: "payment",
      boxId: "box-payment",
    },
  });
  // Tags with a broader/narrower co-occurrence: "infra" spans both boxes (broader),
  // "migration" only the migration box (narrower) → parent edge infra -> migration expected.
  upsertEnrichmentTag({ ...scope, tag: { tagId: "tag-infra", label: "infra" } });
  upsertEnrichmentTag({ ...scope, tag: { tagId: "tag-migration", label: "migration" } });
  upsertEnrichmentTag({ ...scope, tag: { tagId: "tag-payment", label: "payment" } });
  const assoc = (tagId: string, boxId: string) =>
    associateEnrichmentTag({
      ...scope,
      source: "dream",
      tagId,
      target: { type: "box", sessionKey: SESSION_KEY, boxId },
    });
  assoc("tag-infra", "box-migration");
  assoc("tag-infra", "box-payment");
  assoc("tag-migration", "box-migration");
  assoc("tag-payment", "box-payment");
  return stateDir;
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  vi.restoreAllMocks();
});

describe("runAssociativeEnrichment", () => {
  it("writes a real rollup, normalized importance, and summary_embedding_ref for each box", async () => {
    const stateDir = seededStore();
    const env = { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv;
    const result = await runAssociativeEnrichment({
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
      env,
    });
    expect(result.boxesEnriched).toBeGreaterThanOrEqual(2);

    const boxes = listBoxes({ agentId: AGENT_ID, sessionKey: SESSION_KEY, env });
    for (const box of boxes) {
      expect(box.importance).not.toBeNull();
      expect(box.importance as number).toBeGreaterThanOrEqual(0);
      expect(box.importance as number).toBeLessThanOrEqual(1);
      expect(box.summary).not.toBeNull();
      expect(box.summary_embedding_ref).not.toBeNull();
      // Real rollup: multi-turn, longer than the old first-line truncation shape.
      expect((box.summary as string).length).toBeGreaterThan(20);
    }
  });

  it("builds DAG parent edges via the write seam at runtime", async () => {
    const stateDir = seededStore();
    const env = { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv;
    await runAssociativeEnrichment({ agentId: AGENT_ID, sessionKey: SESSION_KEY, env });
    const edges = listEnrichmentTagEdges({ agentId: AGENT_ID, env });
    expect(edges.length).toBeGreaterThanOrEqual(1);
  });

  it("is idempotent: a second run adds no new tag edges and leaves values unchanged", async () => {
    const stateDir = seededStore();
    const env = { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv;
    await runAssociativeEnrichment({ agentId: AGENT_ID, sessionKey: SESSION_KEY, env });
    const boxesAfterFirst = listBoxes({ agentId: AGENT_ID, sessionKey: SESSION_KEY, env }).map(
      (b) => ({ id: b.box_id, imp: b.importance, sum: b.summary, ref: b.summary_embedding_ref }),
    );
    const edgesAfterFirst = listEnrichmentTagEdges({ agentId: AGENT_ID, env }).length;

    await runAssociativeEnrichment({ agentId: AGENT_ID, sessionKey: SESSION_KEY, env });
    const boxesAfterSecond = listBoxes({ agentId: AGENT_ID, sessionKey: SESSION_KEY, env }).map(
      (b) => ({ id: b.box_id, imp: b.importance, sum: b.summary, ref: b.summary_embedding_ref }),
    );
    const edgesAfterSecond = listEnrichmentTagEdges({ agentId: AGENT_ID, env }).length;

    expect(edgesAfterSecond).toBe(edgesAfterFirst);
    expect(boxesAfterSecond).toEqual(boxesAfterFirst);
  });

  it("bounds the number of boxes processed by the per-night cap", async () => {
    const stateDir = seededStore();
    const env = { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv;
    const result = await runAssociativeEnrichment({
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
      env,
      maxBoxes: 1,
    });
    expect(result.boxesEnriched).toBe(1);
  });

  it("emits a §13 decision-log entry per enriched box with score and inputs", async () => {
    const stateDir = seededStore();
    const env = { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv;
    await runAssociativeEnrichment({
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
      env,
      workspaceDir: stateDir,
    });
    const records = await readMemoryHostEventRecords({ workspaceDir: stateDir });
    const enrichEvents = records.filter((r) => r.type === "memory.enrich.box");
    expect(enrichEvents.length).toBeGreaterThanOrEqual(2);
    for (const event of enrichEvents) {
      expect(event.type).toBe("memory.enrich.box");
      if (event.type !== "memory.enrich.box") {
        continue;
      }
      expect(event.importance).toBeGreaterThanOrEqual(0);
      expect(event.importance).toBeLessThanOrEqual(1);
      expect(event.inputs).toHaveProperty("recurrenceCount");
      expect(event.inputs).toHaveProperty("turnDepth");
      expect(event.inputs).toHaveProperty("effortSignal");
    }
  });

  it("does not import a remote model: rollup generation is local-only (§13)", async () => {
    // The producer takes no subagent/model client; a network-triggering global must never
    // be reached. We assert fetch is not called during a run.
    const stateDir = seededStore();
    const env = { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await runAssociativeEnrichment({ agentId: AGENT_ID, sessionKey: SESSION_KEY, env });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
