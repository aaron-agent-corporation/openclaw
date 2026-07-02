/**
 * CLI command for `openclaw memory replay-eval --agent <id>` (Phase 5, 05-05 / D-03). Runs the
 * durable replay precision/recall gate over the agent's backfilled history: every stored user
 * turn becomes an eval query replayed through the SAME pure auto-expand decision the runtime
 * uses, scored recall-safety-first. Read-only and re-runnable — it never writes to the store,
 * so the gate can run against a live agent at any time (e.g. before/after retuning the cutoff).
 */
import { runReplayEval, type ReplayEvalPoint } from "../agents/memory/replay-eval.js";
import { getTurns } from "../agents/memory/turns-store.js";
import { buildAgentMainSessionKey } from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { resolveCommandAgentId } from "./memory-shared.js";

export type MemoryReplayEvalCommandOptions = {
  agent?: string;
  cutoff?: number;
  json?: boolean;
  // Test seam (not a CLI flag): isolate the per-agent DB.
  env?: NodeJS.ProcessEnv;
};

export async function runMemoryReplayEvalCommand(
  options: MemoryReplayEvalCommandOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const agentId = resolveCommandAgentId(options.agent, runtime);
  if (agentId == null) {
    return;
  }
  if (options.cutoff != null && !(Number.isFinite(options.cutoff) && options.cutoff > 0)) {
    runtime.error(`Invalid --cutoff: ${options.cutoff}`);
    runtime.exit(1);
    return;
  }
  const sessionKey = buildAgentMainSessionKey({ agentId });
  const env = options.env;

  // Eval points = the real user queries in seq order, exactly what the runtime saw.
  // Suppressed noise (heartbeats/system pings captured as user turns) is excluded, or
  // hundreds of ~0-scoring pings would inflate precision/token savings and mask failures.
  const evalPoints: ReplayEvalPoint[] = getTurns({ agentId, sessionKey, env })
    .filter(
      (turn) => turn.role === "user" && turn.noise_class == null && turn.content.trim().length > 0,
    )
    .map((turn) => ({ query: turn.content }));

  const result = runReplayEval({ agentId, sessionKey, evalPoints, cutoff: options.cutoff, env });

  if (options.json) {
    writeRuntimeJson(runtime, { agentId, sessionKey, ...result });
    return;
  }
  runtime.log(`Replay eval for agent "${agentId}" (session ${sessionKey})`);
  runtime.log(`Evaluated points: ${result.evaluatedPoints} of ${evalPoints.length} user turn(s).`);
  if (result.evaluatedPoints === 0) {
    // Perfect-looking defaults on zero data are vacuous; say so instead of reading as a pass.
    runtime.log(
      "Warning: nothing was evaluated (no collapsed boxes or no stored user turns) — run `openclaw memory backfill` first.",
    );
  }
  runtime.log(
    `Precision ${result.precision.toFixed(3)}, recall ${result.recall.toFixed(3)}, recall-safety ${result.recallSafetyScore.toFixed(3)}.`,
  );
  runtime.log(
    `Counts: recall ${result.counts.recallCorrect}/${result.counts.recallCorrect + result.counts.recallFailures} correct, ` +
      `precision failures ${result.counts.precisionFailures}, token savings ${result.counts.tokenSavings}.`,
  );
}
