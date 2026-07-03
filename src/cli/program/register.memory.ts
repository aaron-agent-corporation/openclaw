// `openclaw memory`: per-agent conversational-memory maintenance (additive command group).
import type { Command } from "commander";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";

/** Register the `memory` command group + its `backfill` and `replay-eval` subcommands. */
export function registerMemoryCommand(program: Command): void {
  const memory =
    program.commands.find(
      (command) => command.name() === "memory" || command.aliases().includes("memory"),
    ) ?? program.command("memory").description("Maintain per-agent conversational memory");

  // Both subcommands are registered only here, so one presence probe covers the group.
  if (memory.commands.some((command) => command.name() === "backfill")) {
    return;
  }
  registerBackfill(memory);
  registerReplayEval(memory);
}

function registerBackfill(memory: Command): void {
  memory
    .command("backfill")
    .description("Seed and organize an agent's historical transcripts into durable memory")
    .option("--agent <id>", "Agent id whose history to backfill")
    .option("--json", "Output JSON", false)
    .action(async (opts: { agent?: string; json?: boolean }) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        // Lazy-import the command body so the CLI startup path stays small.
        const { runMemoryBackfillCommand } = await import("../../commands/memory-backfill.js");
        await runMemoryBackfillCommand(
          { agent: opts.agent, json: Boolean(opts.json) },
          defaultRuntime,
        );
      });
    });
}

function registerReplayEval(memory: Command): void {
  memory
    .command("replay-eval")
    .description("Score the auto-expand recall gate over an agent's backfilled history (read-only)")
    .option("--agent <id>", "Agent id whose history to replay")
    .option("--cutoff <number>", "Strong-match cutoff override (defaults to the shipped cutoff)")
    .option("--json", "Output JSON", false)
    .action(async (opts: { agent?: string; cutoff?: string; json?: boolean }) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        // Lazy-import the command body so the CLI startup path stays small.
        const { runMemoryReplayEvalCommand } = await import("../../commands/memory-replay-eval.js");
        await runMemoryReplayEvalCommand(
          {
            agent: opts.agent,
            cutoff: opts.cutoff == null ? undefined : Number(opts.cutoff),
            json: Boolean(opts.json),
          },
          defaultRuntime,
        );
      });
    });
}
