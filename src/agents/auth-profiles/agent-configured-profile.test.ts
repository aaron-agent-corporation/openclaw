import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  indexAgentAuthProfilePins,
  listAgentsPinningAuthProfile,
  resolveAgentAuthProfilePin,
  resolveConfiguredAuthProfileId,
} from "./agent-configured-profile.js";

function cfgWithPins(): OpenClawConfig {
  return {
    agents: {
      entries: {
        researcher: {
          auth: {
            profiles: {
              openai: "openai:household",
              anthropic: "anthropic:work",
            },
          },
        },
        coder: {
          auth: {
            profiles: {
              openai: "openai:codex-cli",
            },
          },
        },
      },
    },
  } as OpenClawConfig;
}

describe("agent-configured auth profile pins", () => {
  it("resolves an agent pin for a provider", () => {
    expect(
      resolveAgentAuthProfilePin({
        cfg: cfgWithPins(),
        agentId: "researcher",
        provider: "openai",
      }),
    ).toBe("openai:household");
  });

  it("prefers a model-ref @profile over the agent pin", () => {
    expect(
      resolveConfiguredAuthProfileId({
        cfg: cfgWithPins(),
        agentId: "researcher",
        provider: "openai",
        modelId: "openai/gpt-5.6-sol@openai:personal",
      }),
    ).toBe("openai:personal");
  });

  it("uses the agent pin when the model ref has no profile suffix", () => {
    expect(
      resolveConfiguredAuthProfileId({
        cfg: cfgWithPins(),
        agentId: "researcher",
        provider: "anthropic",
        modelId: "anthropic/claude-sonnet-4-6",
      }),
    ).toBe("anthropic:work");
  });

  it("lists agents that pin a profile", () => {
    expect(
      listAgentsPinningAuthProfile({
        cfg: cfgWithPins(),
        profileId: "openai:household",
      }),
    ).toEqual(["researcher"]);
    expect(indexAgentAuthProfilePins(cfgWithPins()).get("openai:codex-cli")).toEqual(["coder"]);
  });
});
