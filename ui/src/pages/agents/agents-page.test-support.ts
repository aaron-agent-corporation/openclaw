import { vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  AgentsFilesListResult,
  AgentsListResult,
  ModelAuthStatusResult,
  ModelCatalogEntry,
  ToolsEffectiveResult,
} from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { PanelRefreshStatus } from "../../components/panel-refresh-status.ts";
import type { AgentsPanel } from "../../lib/agents/panels.ts";
import type { CronState } from "../../lib/cron/index.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import type { AgentsRouteData } from "./route.ts";

const AGENTS_PAGE_GATEWAY_HELLO = gatewayHelloForMethods(["config.patch", "config.set"]);

export type TestAgentsPage = HTMLElement & {
  context: ApplicationContext;
  readonly client: GatewayBrowserClient | null;
  readonly connected: boolean;
  agentsList: unknown;
  agentsSelectedId: string | null;
  routeData?: AgentsRouteData;
  agentFilesLoading: boolean;
  agentFilesList: AgentsFilesListResult | null;
  agentFileActive: string | null;
  agentFileContents: Record<string, string>;
  agentIdentityLoading: boolean;
  agentSkillsError: string | null;
  readonly agentsPanel: AgentsPanel;
  readonly sessions: ApplicationContext["sessions"];
  toolsEffectiveError: string | null;
  toolsEffectiveLoading: boolean;
  toolsEffectiveResult: ToolsEffectiveResult | null;
  chatModelCatalog: ModelCatalogEntry[];
  modelAuthStatus: ModelAuthStatusResult | null;
  chatModelCatalogStatus: PanelRefreshStatus;
  cron: CronState;
  requestGeneration: number;
  routeDataInitialized: boolean;
  subscriptions: {
    hostConnected: () => void;
    hostUpdate: () => void;
    hostDisconnected: () => void;
  };
  willUpdate: (changed: Map<PropertyKey, unknown>) => void;
  gateway: {
    applySnapshot: (
      snapshot: ApplicationGatewaySnapshot,
      binding: { initial: boolean; sourceChanged: boolean },
    ) => void;
    invalidate: () => void;
  };
  ensureAgentIdentities: () => void;
  loadActivePanelData: () => void;
  ensureModelCatalog: (options?: { refresh?: boolean }) => void;
  refreshCron: () => Promise<void>;
  requestUpdate: () => void;
  runCronTask: <T>(task: (cronState: CronState) => Promise<T>) => Promise<T>;
  loadEffectiveToolsForAgent: (agentId: string) => void;
  loadAgentFiles: (agentId: string, force?: boolean) => Promise<void>;
  clearAgentSkills: (agentId: string) => void;
  saveAgentConfig: () => void;
  setDefaultAgent: (agentId: string) => void;
};

export function setPageGateway(
  page: TestAgentsPage,
  client: GatewayBrowserClient | null,
  connected = true,
  sourceChanged = false,
) {
  page.gateway.applySnapshot(snapshot(client, connected), { initial: false, sourceChanged });
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export function snapshot(
  client: GatewayBrowserClient | null,
  connected = true,
): ApplicationGatewaySnapshot {
  return {
    client,
    phase: connected ? "connected" : "stopped",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: AGENTS_PAGE_GATEWAY_HELLO,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
}

export function gateway(current: ApplicationGatewaySnapshot): ApplicationContext["gateway"] {
  return {
    snapshot: current,
    subscribe: vi.fn(() => () => undefined),
  } as unknown as ApplicationContext["gateway"];
}

export const files = (agentId: string, workspace: string) => ({ agentId, workspace, files: [] });

export const agentsList: AgentsListResult = {
  defaultId: "main",
  mainKey: "main",
  scope: "per-sender",
  agents: [{ id: "main", name: "Main" }],
};

export function agentsRouteData(
  currentGateway: ApplicationContext["gateway"],
  roster: AgentsListResult | null = agentsList,
  requestedAgentId: string | null = "main",
): AgentsRouteData {
  const pathname = requestedAgentId ? `/settings/agents/${requestedAgentId}` : "/settings/agents";
  return {
    gateway: currentGateway,
    gatewaySnapshot: currentGateway.snapshot,
    location: { pathname, search: "", hash: "" },
    requestedAgentId,
    panel: "files",
    agentsList: roster,
    error: null,
  };
}

export function agentsCapability(ensureFiles: () => Promise<AgentsFilesListResult>) {
  return {
    state: {
      client: null,
      connected: true,
      agentsLoading: false,
      agentsError: null,
      agentsList,
    },
    files: () => ({ list: null, loading: false, error: null }),
    ensureList: vi.fn(async () => agentsList),
    refreshList: vi.fn(async () => agentsList),
    ensureFiles,
    refreshFiles: ensureFiles,
    subscribe: vi.fn(() => () => undefined),
  } as unknown as ApplicationContext["agents"];
}

export function pageContext(
  currentGateway: ApplicationContext["gateway"],
  agents: ApplicationContext["agents"],
  options?: {
    agentIdentity?: ApplicationContext["agentIdentity"];
    sessions?: ApplicationContext["sessions"];
  },
): ApplicationContext {
  const subscribe = vi.fn(() => () => undefined);
  return {
    gateway: currentGateway,
    agents,
    agentIdentity:
      options?.agentIdentity ??
      ({
        get: () => ({ agentId: "main" }),
        entries: () => [],
        ensure: vi.fn(async () => undefined),
        subscribe,
      } as unknown as ApplicationContext["agentIdentity"]),
    sessions:
      options?.sessions ??
      ({
        state: { result: null, modelOverrides: {} },
        subscribe,
      } as unknown as ApplicationContext["sessions"]),
    channels: { subscribe },
    runtimeConfig: { subscribe },
  } as unknown as ApplicationContext;
}
