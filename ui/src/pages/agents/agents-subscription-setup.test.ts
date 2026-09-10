/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { createInitialConfigState } from "../../lib/config/config-state-model.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { getRenderedModalDialog, installDialogPolyfill } from "../../test-helpers/modal-dialog.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  agentsCapability,
  agentsRouteData,
  deferred,
  files,
  gateway,
  pageContext,
  snapshot,
  type TestAgentsPage,
} from "./agents-page.test-support.ts";
import "./agents-page.ts";

describe("AgentsPage subscription setup", () => {
  it("restores the launch control after focus moves during asynchronous setup", async () => {
    const dispatch = deferred<void>();
    const request = vi.fn(async (method: string) => {
      if (method === "chat.metadata") {
        return { models: [] };
      }
      if (method === "models.authStatus") {
        return { ts: 1, providers: [] };
      }
      if (method === "openclaw.setup.detect") {
        return {
          candidates: [],
          unavailableCandidates: [],
          manualProviders: [],
          authOptions: [{ id: "provider-auth", label: "Provider", kind: "oauth" }],
          prepareOptions: [],
          recommendedInstalls: [],
          workspace: "/tmp/workspace",
          setupComplete: false,
        };
      }
      if (method === "openclaw.setup.auth.start") {
        return { done: false, status: "running" };
      }
      if (method === "wizard.next") {
        return {
          done: false,
          status: "running",
          step: { id: "token", type: "text", message: "Paste token" },
        };
      }
      if (method === "wizard.cancel") {
        return { status: "cancelled" };
      }
      throw new Error(`Unexpected subscription RPC: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const currentGateway = gateway({
      ...snapshot(client),
      hello: gatewayHelloForMethods([
        "config.set",
        "openclaw.setup.detect",
        "openclaw.setup.auth.start",
      ]),
    });
    const context = pageContext(
      currentGateway,
      agentsCapability(async () => files("main", "unused")),
    );
    const provider = createApplicationContextProvider({
      ...context,
      basePath: "",
      channels: { ...context.channels, state: {} },
      navigation: { snapshot: { pinnedAgentIds: [] }, subscribe: () => () => undefined },
      runtimeConfig: {
        ...context.runtimeConfig,
        state: { ...createInitialConfigState(), configForm: { agents: { entries: { main: {} } } } },
        ensureLoaded: async () => undefined,
        runExternalMutation: async (task: (client: GatewayBrowserClient) => Promise<unknown>) => {
          await dispatch.promise;
          return { ok: true, value: await task(client), refresh: { ok: true } };
        },
      },
    } as unknown as ApplicationContext);
    const page = document.createElement("openclaw-agents-page") as TestAgentsPage & {
      updateComplete: Promise<boolean>;
    };
    page.routeData = { ...agentsRouteData(currentGateway), panel: "overview" };
    const otherControl = document.createElement("button");
    const restoreDialogPolyfill = installDialogPolyfill();
    try {
      provider.append(page);
      document.body.append(provider, otherControl);
      await page.updateComplete;
      const addSubscription = Array.from(page.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === t("agents.overview.authPinAddSubscription"),
      );
      expect(addSubscription).toBeDefined();
      addSubscription!.click();
      await waitForFast(() =>
        expect(page.querySelector('[data-auth-choice="provider-auth"]')).not.toBeNull(),
      );
      const trigger = page.querySelector<HTMLButtonElement>('[data-auth-choice="provider-auth"]')!;
      trigger.focus();
      trigger.click();
      await page.updateComplete;
      expect(trigger.disabled).toBe(true);
      // A config flush disables the launch control before the dialog exists;
      // focus can move to another control during that admission window.
      otherControl.focus();
      expect(document.activeElement).toBe(otherControl);
      dispatch.resolve();
      await waitForFast(() => expect(page.textContent).toContain("Paste token"));
      const { modal, dialog } = await getRenderedModalDialog(page);
      expect(dialog.open).toBe(true);
      const cancel = Array.from(modal.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === t("common.cancel"),
      );
      expect(cancel).toBeDefined();
      cancel!.click();
      await waitForFast(() => {
        expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
        expect(document.activeElement).toBe(trigger);
      });
    } finally {
      dispatch.resolve();
      provider.remove();
      otherControl.remove();
      await page.updateComplete;
      restoreDialogPolyfill();
    }
  });
});
