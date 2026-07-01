// `openclaw memory`: per-agent conversational-memory maintenance (additive command group).
import type { Command } from "commander";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";

/** Register the `memory` command group + its `backfill` subcommand. */
export function registerMemoryCommand(program: Command): void {
  const memory =
    program.commands.find(
      (command) => command.name() === "memory" || command.aliases().includes("memory"),
    ) ?? program.command("memory").description("Maintain per-agent conversational memory");

  if (memory.commands.some((command) => command.name() === "backfill")) {
    return;
  }

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
