/**
 * CLI command for `openclaw memory tune --agent <id>` (Phase 4, 04-04). Runs the offline tuning
 * harness over the agent's BACKFILLED history: it replays the parameterized auto-collapse rule
 * under each candidate rule-set, scores every timeline against the deterministic recall-safety
 * reference, and prints the ranked winner plus aggregate evidence. Output is AGGREGATE NUMBERS
 * ONLY (no transcript content), so the report is safe to paste into a PR body (T-04D-01). The
 * command never writes the tuning constants file — the operator-confirm gate + lock step own
 * that. Per-agent and opt-in: it reads exactly the one operator-named agent's store and runs
 * only via this explicit CLI entry (D-08).
 */
import { runTuningHarness } from "../agents/memory/tuning-harness.js";
import { isValidAgentId, normalizeAgentId } from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";

export type MemoryTuneCommandOptions = {
  agent?: string;
  json?: boolean;
  // Test seam (not exposed as a CLI flag): isolate the per-agent DB so the command can run
  // end-to-end without a real home dir.
  env?: NodeJS.ProcessEnv;
};

/**
 * Validate the operator-supplied agent id with the canonical `isValidAgentId` before it reaches
 * path/DB resolution (no traversal before path resolution), mirroring `memory backfill`.
 */
function resolveCommandAgentId(raw: string | undefined, runtime: RuntimeEnv): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) {
    runtime.error("--agent <id> is required.");
    runtime.exit(1);
    return null;
  }
  if (!isValidAgentId(trimmed)) {
    runtime.error(`Invalid --agent id: ${trimmed}`);
    runtime.exit(1);
    return null;
  }
  return normalizeAgentId(trimmed);
}

export async function runMemoryTuneCommand(
  options: MemoryTuneCommandOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const agentId = resolveCommandAgentId(options.agent, runtime);
  if (agentId == null) {
    return;
  }

  const result = runTuningHarness({ agentId, env: options.env });

  if (options.json) {
    writeRuntimeJson(runtime, { agentId, ...result });
    return;
  }

  const { evidence, disagreements } = result;
  runtime.log(`Tuning memory auto-collapse for agent "${agentId}" (session agent:${agentId}:main)`);
  runtime.log(
    `Winner: ${evidence.winner.name} (value ${evidence.winner.value}, ` +
      `${evidence.winner.recallFailures} recall failure(s), ${evidence.winner.savingsPct}% saved).`,
  );
  runtime.log(
    `Baseline: ${evidence.baseline.name} (value ${evidence.baseline.value}, ` +
      `${evidence.baseline.recallFailures} recall failure(s), ${evidence.baseline.savingsPct}% saved).`,
  );
  for (const candidate of evidence.candidates) {
    runtime.log(
      `  ${candidate.name}: value ${candidate.value}, ${candidate.recallFailures} recall ` +
        `failure(s), ${candidate.savingsPct}% saved, thrash ${candidate.thrash}.`,
    );
  }
  runtime.log(`Decisive disagreements (winner vs runner-up): ${disagreements.length}.`);
}
