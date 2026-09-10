import { describe, expect, it } from "vitest";
import type { ModelAuthStatusResult } from "../../api/types.ts";
import {
  collectPinnedProviderIds,
  createAuthPinDraft,
  findNewAuthProfilePin,
  formatAuthPinProfileLabel,
  listAuthPinProfileOptions,
  listAuthPinProviderOptions,
  modelNeedsAuthPinHint,
  orderModelOptionsForAuthPins,
} from "./auth-pins.ts";

function authStatus(providers: ModelAuthStatusResult["providers"]): ModelAuthStatusResult {
  return { ts: 1, providers };
}

describe("agent auth pins helpers", () => {
  it("keeps Add pin drafts visible until a profile is chosen", () => {
    const draft = createAuthPinDraft();
    expect(draft.provider).toBe("");
    expect(draft.profileId).toBe("");
    expect(draft.draftId).toBeTruthy();
  });

  it("lists labeled provider and profile options from auth status", () => {
    const status = authStatus([
      {
        provider: "openai",
        displayName: "OpenAI",
        status: "ok",
        profiles: [
          {
            profileId: "openai:roscoe",
            type: "oauth",
            status: "ok",
            displayName: "roscoe@example.com",
            email: "roscoe@example.com",
          },
        ],
      },
    ]);
    expect(listAuthPinProviderOptions(status)).toEqual([{ value: "openai", label: "OpenAI" }]);
    expect(listAuthPinProfileOptions(status, "openai")).toEqual([
      {
        value: "openai:roscoe",
        label: "roscoe@example.com (subscription)",
        type: "oauth",
        externallyManaged: undefined,
      },
    ]);
    expect(
      formatAuthPinProfileLabel({
        profileId: "openai:cli",
        type: "token",
        status: "ok",
        displayName: "Codex CLI",
        externallyManaged: true,
      }),
    ).toBe("Codex CLI (CLI)");
  });

  it("prefers pinned-provider models and keeps others in a secondary group", () => {
    const ordered = orderModelOptionsForAuthPins(
      [
        { value: "", label: "Inherit" },
        { value: "openai/gpt-5.6-sol", label: "Sol", provider: "openai" },
        { value: "anthropic/claude-opus-4-6", label: "Opus", provider: "anthropic" },
      ],
      new Set(["openai"]),
      "Other providers",
    );
    expect(ordered.map((option) => option.value)).toEqual([
      "",
      "openai/gpt-5.6-sol",
      "__openclaw_auth_pin_other_providers__",
      "anthropic/claude-opus-4-6",
    ]);
    expect(ordered[2]?.disabled).toBe(true);
    expect(modelNeedsAuthPinHint("anthropic/claude-opus-4-6", new Set(["openai"]))).toBe(true);
    expect(modelNeedsAuthPinHint("openai/gpt-5.6-sol", new Set(["openai"]))).toBe(false);
    expect(collectPinnedProviderIds({ openai: "openai:roscoe", "": "" }).has("openai")).toBe(true);
  });

  it("finds a newly loaded subscription profile to auto-pin", () => {
    const before = authStatus([
      {
        provider: "openai",
        displayName: "OpenAI",
        status: "ok",
        profiles: [
          {
            profileId: "openai:old",
            type: "oauth",
            status: "ok",
            displayName: "old",
          },
        ],
      },
    ]);
    const after = authStatus([
      {
        provider: "openai",
        displayName: "OpenAI",
        status: "ok",
        profiles: [
          {
            profileId: "openai:old",
            type: "oauth",
            status: "ok",
            displayName: "old",
          },
          {
            profileId: "openai:new",
            type: "oauth",
            status: "ok",
            displayName: "new@example.com",
          },
          {
            profileId: "openai:cli",
            type: "token",
            status: "ok",
            displayName: "CLI",
            externallyManaged: true,
          },
        ],
      },
    ]);
    expect(
      findNewAuthProfilePin({
        before,
        after,
        providerHint: "openai",
      }),
    ).toEqual({ provider: "openai", profileId: "openai:new" });
  });
  it("requires one new account for the completed provider before auto-pinning", () => {
    const profile = (profileId: string) => ({
      profileId,
      type: "oauth" as const,
      status: "ok" as const,
    });
    const after = authStatus([
      {
        provider: "openai",
        displayName: "OpenAI",
        status: "ok",
        profiles: [profile("openai:first"), profile("openai:second")],
      },
      {
        provider: "anthropic",
        displayName: "Anthropic",
        status: "ok",
        profiles: [profile("anthropic:new")],
      },
    ]);
    expect(
      findNewAuthProfilePin({ before: authStatus([]), after, providerHint: "openai" }),
    ).toBeNull();
    expect(findNewAuthProfilePin({ before: null, after, providerHint: "anthropic" })).toBeNull();
    expect(
      findNewAuthProfilePin({ before: authStatus([]), after, providerHint: "missing" }),
    ).toBeNull();
    expect(
      findNewAuthProfilePin({ before: authStatus([]), after, providerHint: "anthropic" }),
    ).toEqual({ provider: "anthropic", profileId: "anthropic:new" });
  });
});
