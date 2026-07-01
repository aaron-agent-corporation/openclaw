// 05-05 Task 2: replay precision/recall harness over the backfilled main history (D-03 acceptance
// gate). Seeds a fixture turns/spans/boxes store, replays the accordion-aware auto-expand decision
// at eval points against a topic-switch reference derived from the history, and asserts the
// classification (recall/precision correct/failure) + a computed recall-safety score. Deterministic
// and re-runnable: identical inputs yield identical scores.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it } from "vitest";
import { associateMemoryEntity, upsertMemoryEntity } from "./associative-store.js";
import { runReplayEval, type ReplayEvalPoint } from "./replay-eval.js";
import { appendTurns, upsertBox, upsertSpan, type NewTurn } from "./turns-store.js";

const AGENT_ID = "main";
const SESSION_KEY = "agent:main:main";

const stateDirs: string[] = [];

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  for (const dir of stateDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-replay-"));
  stateDirs.push(dir);
  return dir;
}

function turn(tag: string, role: string, content: string): NewTurn {
  return { role, content, contentHash: `h-${tag}`, idempotencyKey: `k-${tag}`, ts: 1 };
}

function linkBoxEntity(
  scope: { agentId: string; env: NodeJS.ProcessEnv },
  boxId: string,
  entity: string,
): void {
  upsertMemoryEntity({
    ...scope,
    entity: { entityId: `e-${entity}`, label: entity, type: "person" },
  });
  associateMemoryEntity({
    ...scope,
    entityId: `e-${entity}`,
    source: "dream",
    target: { type: "box", boxId, sessionKey: SESSION_KEY },
  });
}

/**
 * Seed a store with two collapsed topic boxes drawn from the real spike report (a Fidel SOL box
 * and a vendor-payment box). Each owns a span so the rollup inputs resolve; both are collapsed so
 * they are auto-expand candidates.
 */
function seededStore(): { env: NodeJS.ProcessEnv } {
  const stateDir = tempStateDir();
  const env = { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv;
  const scope = { agentId: AGENT_ID, env };
  appendTurns({
    ...scope,
    sessionKey: SESSION_KEY,
    turns: [
      turn(
        "1",
        "user",
        "Filevine flags the Fidel Bueso-Sandoval case near its statute of limitations",
      ),
      turn(
        "2",
        "assistant",
        "Routed the Fidel SOL deadline alert to Perry for the litigation review",
      ),
      turn("3", "user", "The Perplexity subscription payment failed again this month"),
      turn("4", "assistant", "Logged the Perplexity vendor payment-failure exception for billing"),
    ],
  });
  upsertBox({
    ...scope,
    box: {
      boxId: "box-fidel",
      sessionKey: SESSION_KEY,
      label: "Fidel Bueso-Sandoval SOL deadline",
      state: "collapsed",
      summary: "Filevine statute-of-limitations deadline alert for the Fidel Bueso-Sandoval case",
    },
  });
  upsertBox({
    ...scope,
    box: {
      boxId: "box-vendor",
      sessionKey: SESSION_KEY,
      label: "Vendor payment-failure exceptions",
      state: "collapsed",
      summary: "Recurring Perplexity vendor subscription payment-failure billing exceptions",
    },
  });
  // The recurring named entity is the real retrieval key (spike report §5/§6): a specific
  // case / vendor is what resurfaces days later. Link each box's entity so a later re-reference
  // grounds via the exact-entity floor exactly as the runtime auto-expand does.
  linkBoxEntity(scope, "box-fidel", "fidel");
  linkBoxEntity(scope, "box-vendor", "perplexity");
  upsertSpan({
    ...scope,
    span: {
      spanId: "s-fidel",
      sessionKey: SESSION_KEY,
      startSeq: 1,
      endSeq: 2,
      boxId: "box-fidel",
    },
  });
  upsertSpan({
    ...scope,
    span: {
      spanId: "s-vendor",
      sessionKey: SESSION_KEY,
      startSeq: 3,
      endSeq: 4,
      boxId: "box-vendor",
    },
  });
  return { env };
}

const evalPoints: ReplayEvalPoint[] = [
  // Recall opportunity: the query re-references the collapsed Fidel box → should expand it.
  { query: "what is the Fidel Bueso-Sandoval statute of limitations deadline status" },
  // No-op: a fresh topic references no collapsed box → correct to leave everything collapsed.
  { query: "please summarize today's weather forecast" },
];

describe("runReplayEval", () => {
  it("classifies recall/precision decisions and computes a recall-safety score", () => {
    const { env } = seededStore();
    const result = runReplayEval({ agentId: AGENT_ID, sessionKey: SESSION_KEY, evalPoints, env });

    // The Fidel re-reference is a recall opportunity the strong-match auto-expand should catch.
    expect(result.counts.recallCorrect).toBe(1);
    expect(result.counts.recallFailures).toBe(0);
    // The weather turn references no collapsed box → correct no-expand (precision-correct).
    expect(result.counts.precisionCorrect).toBe(1);
    expect(result.counts.precisionFailures).toBe(0);

    expect(result.recall).toBe(1);
    expect(result.precision).toBe(1);
    // A clean run has no failure penalties; a small positive savings nudge lifts it above 0
    // but stays bounded well below one precision penalty (the tie-breaker can never dominate).
    expect(result.recallSafetyScore).toBeGreaterThanOrEqual(0);
    expect(result.recallSafetyScore).toBeLessThan(1);
  });

  it("records a recall failure when a raised cutoff drops a still-needed topic", () => {
    const { env } = seededStore();
    // Cutoff at 1.1 is unreachable → the Fidel re-reference is NOT expanded despite being needed.
    const result = runReplayEval({
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
      evalPoints,
      cutoff: 1.1,
      env,
    });
    expect(result.counts.recallFailures).toBe(1);
    expect(result.recall).toBe(0);
    // A recall failure drags the recall-safety score below zero (penalized hardest).
    expect(result.recallSafetyScore).toBeLessThan(0);
  });

  it("is deterministic: identical inputs yield identical scores", () => {
    const a = runReplayEval({
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
      evalPoints,
      env: seededStore().env,
    });
    const b = runReplayEval({
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
      evalPoints,
      env: seededStore().env,
    });
    expect(a).toEqual(b);
  });

  it("returns an empty-but-valid result over an empty store (re-runnable gate, no throw)", () => {
    const stateDir = tempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv;
    const result = runReplayEval({ agentId: AGENT_ID, sessionKey: SESSION_KEY, evalPoints, env });
    expect(result.counts.recallFailures).toBe(0);
    expect(result.counts.precisionFailures).toBe(0);
    // No collapsed boxes → no recall opportunities → recall is reported as 1 (nothing missed).
    expect(result.recall).toBe(1);
    expect(result.recallSafetyScore).toBe(0);
  });
});
