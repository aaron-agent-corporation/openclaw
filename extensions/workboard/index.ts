// Workboard plugin entrypoint registers its OpenClaw integration.
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { definePluginEntry } from "./api.js";
import { registerWorkboardGatewayMethods } from "./runtime-api.js";
import { createWorkboardAutoAdvanceService } from "./src/auto-advance.js";
import { createWorkboardAutomationNudgeService } from "./src/automation-nudge.js";
import { createWorkboardChangeEventService } from "./src/change-events.js";
import { registerWorkboardCommand } from "./src/command.js";
import { dispatchAndStartWorkboardCards } from "./src/dispatcher.js";
import { workboardHostDispatchOptions } from "./src/gateway-helpers.js";
import {
  createWorkboardLifecycleService,
  readWorkboardLifecycleSessions,
  syncWorkboardAgentEnded,
  syncWorkboardSubagentEnded,
} from "./src/lifecycle-sync.js";
import { registerWorkboardStoreLifecycle } from "./src/store-lifecycle.js";
import { WorkboardStore } from "./src/store.js";
import { createWorkboardTools } from "./src/tools.js";
import {
  guardWorkboardToolsForWorkspaceAccess,
  WORKBOARD_TOOL_NAMES,
} from "./src/workspace-access.js";

export default definePluginEntry({
  id: "workboard",
  name: "Workboard",
  description: "Dashboard workboard for agent-owned issues and sessions.",
  register(api) {
    const store = WorkboardStore.openSqlite();
    const changeEvents = createWorkboardChangeEventService(store);
    const automationNudge = createWorkboardAutomationNudgeService({
      store,
      gateway: api.runtime.gateway,
    });
    const autoAdvance = createWorkboardAutoAdvanceService({
      store,
      // Gateway-owned dispatch runs with host authority like in-process gateway
      // dispatch; each card's recorded workspace authority still intersects it.
      dispatch: async ({ boardId, now, startGate }) =>
        await dispatchAndStartWorkboardCards({
          store,
          subagent: api.runtime.subagent,
          worktrees: api.runtime.worktrees,
          options: {
            ...workboardHostDispatchOptions({
              api,
              config: () => getRuntimeConfig(),
              workspaceAccess: { unrestricted: true },
              input: { boardId, now },
            }),
            startGate,
          },
        }),
    });
    const lifecycleSync = createWorkboardLifecycleService({
      store,
      worktrees: api.runtime.worktrees,
      readSessions: async (options) =>
        await readWorkboardLifecycleSessions(api.runtime.gateway, options),
      onReconciled: autoAdvance.onLifecycleSweep,
    });
    registerWorkboardStoreLifecycle(api, store, () => {
      changeEvents.stop();
      automationNudge.stop();
      lifecycleSync.stop();
      autoAdvance.stop();
    });
    const onLifecycleMatched = async (input: {
      cards: readonly WorkboardCard[];
      sessionKey?: string;
    }) => {
      autoAdvance.onLifecycleMatched(input);
      await automationNudge.nudge(input);
    };
    api.session.controls.registerControlUiDescriptor({
      surface: "tab",
      id: "workboard",
      label: "Workboard",
      placement: "route:workboard",
      icon: "kanban",
      group: "control",
      requiredScopes: ["operator.read"],
    });
    api.session.controls.registerControlUiDescriptor({
      surface: "widget",
      id: "board",
      label: "Workboard board",
      requiredScopes: ["operator.read"],
    });
    api.session.controls.registerControlUiDescriptor({
      surface: "widget",
      id: "card",
      label: "Workboard card",
      requiredScopes: ["operator.write"],
    });
    api.session.controls.registerControlUiDescriptor({
      surface: "widget",
      id: "mini",
      label: "Workboard summary",
      requiredScopes: ["operator.read"],
    });
    registerWorkboardGatewayMethods({ api, store, autoAdvance });
    registerWorkboardCommand({ api, store });
    api.registerService(changeEvents);
    api.registerService(automationNudge);
    api.registerService(autoAdvance);
    api.registerService(lifecycleSync);
    api.on("gateway_start", () => lifecycleSync.onGatewayStart());
    api.on("gateway_stop", () => {
      lifecycleSync.onGatewayStop();
      autoAdvance.onGatewayStop();
    });
    api.on("subagent_ended", (event) =>
      store.runOperation(async () => {
        await syncWorkboardSubagentEnded({
          store,
          worktrees: api.runtime.worktrees,
          event,
          onMatched: onLifecycleMatched,
        });
      }),
    );
    api.on("agent_end", (event, context) =>
      store.runOperation(async () => {
        await syncWorkboardAgentEnded({
          store,
          event,
          context,
          onMatched: onLifecycleMatched,
        });
      }),
    );
    api.registerCli(
      async ({ program }) => {
        const { registerWorkboardCli } = await import("./src/cli.js");
        registerWorkboardCli({ program, store });
      },
      {
        descriptors: [
          {
            name: "workboard",
            description: "Manage Workboard cards and worker dispatch",
            hasSubcommands: true,
          },
        ],
      },
    );
    api.registerTool(
      (context) =>
        guardWorkboardToolsForWorkspaceAccess(
          createWorkboardTools({ context, store, autoAdvance }),
          context,
          api.runtime.sandbox.resolveWorkspaceAuthority,
        ),
      {
        names: [...WORKBOARD_TOOL_NAMES],
        optional: true,
      },
    );
  },
});
