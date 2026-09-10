/**
 * Agent-configured auth profile pins.
 * Resolves providers → profile ids from agents.entries.<id>.auth.profiles and
 * combines them with model-ref @profile suffixes for admission.
 */
import {
  findNormalizedProviderValue,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { listAgentEntries, resolveAgentConfig } from "../agent-scope-config.js";
import { splitTrailingAuthProfile } from "../model-ref-profile.js";

/** Returns the agent pin for one provider, if configured. */
export function resolveAgentAuthProfilePin(params: {
  cfg: OpenClawConfig;
  agentId?: string | null;
  provider: string;
}): string | undefined {
  const agentId = normalizeOptionalString(params.agentId);
  if (!agentId) {
    return undefined;
  }
  const profiles = resolveAgentConfig(params.cfg, agentId)?.auth?.profiles;
  if (!profiles) {
    return undefined;
  }
  const pinned = findNormalizedProviderValue(profiles, params.provider);
  return normalizeOptionalString(pinned);
}

/**
 * Configured profile for a turn: model-ref `@profile` wins over the agent pin.
 * Session user pins stay outside this helper (resolveSessionAuthSelection).
 */
export function resolveConfiguredAuthProfileId(params: {
  cfg: OpenClawConfig;
  agentId?: string | null;
  provider: string;
  modelId?: string | null;
}): string | undefined {
  const fromModel = params.modelId
    ? normalizeOptionalString(splitTrailingAuthProfile(params.modelId).profile)
    : undefined;
  if (fromModel) {
    return fromModel;
  }
  return resolveAgentAuthProfilePin(params);
}

/** Indexes the agents that pin each auth profile. */
export function indexAgentAuthProfilePins(cfg: OpenClawConfig): Map<string, string[]> {
  const byProfile = new Map<string, string[]>();
  for (const entry of listAgentEntries(cfg)) {
    const profiles = entry.auth?.profiles;
    if (!profiles) {
      continue;
    }
    for (const [provider, profileId] of Object.entries(profiles)) {
      const id = normalizeOptionalString(profileId);
      if (!id || !normalizeProviderId(provider)) {
        continue;
      }
      const existing = byProfile.get(id);
      if (existing) {
        if (!existing.includes(entry.id)) {
          existing.push(entry.id);
        }
      } else {
        byProfile.set(id, [entry.id]);
      }
    }
  }
  for (const agents of byProfile.values()) {
    agents.sort((a, b) => a.localeCompare(b));
  }
  return byProfile;
}
