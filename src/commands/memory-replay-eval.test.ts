// `openclaw memory replay-eval` command (05-05 follow-through): proves the CLI wiring around the
// replay harness — a coercion-prone --agent id is rejected before any store access, and a seeded
// store yields a JSON result whose eval points are exactly the stored user turns. The scoring
// itself is covered by replay-eval.test.ts; this file only proves the command boundary. DI: temp
// DB env injected; runtime is a capture stub, never the real process runtime.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendTurns, upsertBox, upsertSpan, type NewTurn } from "../agents/memory/turns-store.js";
import type { RuntimeEnv } from "../runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { runMemoryReplayEvalCommand } from "./memory-replay-eval.js";

const AGENT_ID = "main";
const SESSION_KEY = "agent:main:main";

const stateDirs: string[] = [];

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  for (const dir of stateDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempEnv(): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-replay-cmd-"));
  stateDirs.push(dir);
  return { OPENCLAW_STATE_DIR: dir } as NodeJS.ProcessEnv;
}

type CaptureRuntime = RuntimeEnv & { logs: string[]; errors: string[]; exitCode: number | null };

function captureRuntime(): CaptureRuntime {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    exitCode: null,
    log: (...args: unknown[]) => logs.push(args.join(" ")),
    error: (...args: unknown[]) => errors.push(args.join(" ")),
    exit(code: number) {
      this.exitCode = code;
    },
  };
}

function turn(tag: string, role: string, content: string): NewTurn {
  return { role, content, contentHash: `h-${tag}`, idempotencyKey: `k-${tag}`, ts: 1 };
}

function seedStore(env: NodeJS.ProcessEnv): void {
  const scope = { agentId: AGENT_ID, env };
  appendTurns({
    ...scope,
    sessionKey: SESSION_KEY,
    turns: [
      turn("1", "user", "Filevine flags the Fidel Bueso-Sandoval case near its deadline"),
      turn("2", "assistant", "Routed the Fidel deadline alert to Perry"),
      turn("3", "user", "please summarize today's weather forecast"),
    ],
  });
  upsertBox({
    ...scope,
    box: {
      boxId: "box-fidel",
      sessionKey: SESSION_KEY,
      label: "Fidel Bueso-Sandoval deadline",
      state: "collapsed",
      summary: "Filevine deadline alert for the Fidel Bueso-Sandoval case",
    },
  });
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
}

describe("runMemoryReplayEvalCommand", () => {
  it("rejects a coercion-prone --agent id before touching the store", async () => {
    const runtime = captureRuntime();
    await runMemoryReplayEvalCommand({ agent: "../other", env: tempEnv() }, runtime);
    expect(runtime.exitCode).toBe(1);
    expect(runtime.errors.join("\n")).toContain("Invalid --agent id");
  });

  it("rejects a non-positive --cutoff", async () => {
    const runtime = captureRuntime();
    await runMemoryReplayEvalCommand({ agent: AGENT_ID, cutoff: 0, env: tempEnv() }, runtime);
    expect(runtime.exitCode).toBe(1);
    expect(runtime.errors.join("\n")).toContain("Invalid --cutoff");
  });

  it("replays the stored user turns and reports a JSON result", async () => {
    const env = tempEnv();
    seedStore(env);
    const runtime = captureRuntime();
    await runMemoryReplayEvalCommand({ agent: AGENT_ID, json: true, env }, runtime);
    expect(runtime.exitCode).toBeNull();
    const payload = JSON.parse(runtime.logs.join("\n")) as {
      agentId: string;
      sessionKey: string;
      precision: number;
      recall: number;
      evaluatedPoints: number;
    };
    expect(payload.agentId).toBe(AGENT_ID);
    expect(payload.sessionKey).toBe(SESSION_KEY);
    // Both stored user turns are eval points (the assistant turn is not a query). The Fidel
    // query re-references the collapsed box (recall correct) and the weather query correctly
    // leaves it collapsed (precision correct), so this deterministic fixture scores perfectly.
    expect(payload.evaluatedPoints).toBe(2);
    expect(payload.precision).toBe(1);
    expect(payload.recall).toBe(1);
  });
});
