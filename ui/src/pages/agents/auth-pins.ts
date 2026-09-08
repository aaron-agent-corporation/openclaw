import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { ModelAuthStatusProfile, ModelAuthStatusResult } from "../../api/types.ts";
import type { ModelPickerOption } from "../../components/model-picker.ts";
import {
  canonicalModelAuthProviderId,
  listEffectiveModelAuthProviders,
} from "../../lib/model-auth.ts";

export type AgentAuthPinDraft = {
  draftId: string;
  provider: string;
  profileId: string;
};

export type AgentAuthPinProviderOption = {
  value: string;
  label: string;
};

export type AgentAuthPinProfileOption = {
  value: string;
  label: string;
  type: ModelAuthStatusProfile["type"];
  cliSubscription?: boolean;
};

const OTHER_PROVIDERS_SEPARATOR = "__openclaw_auth_pin_other_providers__";

export function createAuthPinDraft(
  drafts: readonly AgentAuthPinDraft[],
  committed: Record<string, string>,
): AgentAuthPinDraft {
  const used = new Set([
    ...Object.keys(committed).map((provider) => normalizeLowercaseStringOrEmpty(provider)),
    ...drafts
      .map((draft) => normalizeOptionalString(draft.provider))
      .filter((provider): provider is string => Boolean(provider))
      .map((provider) => normalizeLowercaseStringOrEmpty(provider)),
  ]);
  let provider = "";
  if (!used.has("openai")) {
    provider = "openai";
  }
  return {
    draftId: crypto.randomUUID(),
    provider,
    profileId: "",
  };
}

export function listAuthPinProviderOptions(
  authStatus: ModelAuthStatusResult | null,
  extraProviders: readonly string[] = [],
): AgentAuthPinProviderOption[] {
  const seen = new Set<string>();
  const options: AgentAuthPinProviderOption[] = [];
  const add = (provider: string, label?: string) => {
    const id = normalizeOptionalString(provider);
    if (!id) {
      return;
    }
    const key = normalizeLowercaseStringOrEmpty(canonicalModelAuthProviderId(id));
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    options.push({
      value: canonicalModelAuthProviderId(id),
      label: label?.trim() || canonicalModelAuthProviderId(id),
    });
  };

  for (const provider of listEffectiveModelAuthProviders(authStatus?.providers ?? [])) {
    add(provider.provider, provider.displayName);
  }
  for (const capability of authStatus?.providerCapabilities ?? []) {
    add(capability.provider);
  }
  for (const provider of extraProviders) {
    add(provider);
  }
  return options.toSorted((a, b) => a.label.localeCompare(b.label));
}

export function formatAuthPinProfileLabel(profile: ModelAuthStatusProfile): string {
  const base =
    normalizeOptionalString(profile.label) ||
    normalizeOptionalString(profile.email) ||
    profile.profileId;
  if (profile.cliSubscription) {
    return `${base} (CLI)`;
  }
  if (profile.type === "api_key") {
    return `${base} (API key)`;
  }
  if (profile.type === "oauth" || profile.type === "token") {
    return `${base} (subscription)`;
  }
  return base;
}

export function listAuthPinProfileOptions(
  authStatus: ModelAuthStatusResult | null,
  provider: string,
  selectedProfileId?: string,
): AgentAuthPinProfileOption[] {
  const providerId = normalizeOptionalString(provider);
  if (!providerId) {
    return [];
  }
  const canonical = canonicalModelAuthProviderId(providerId);
  const options: AgentAuthPinProfileOption[] = [];
  const seen = new Set<string>();
  for (const entry of listEffectiveModelAuthProviders(authStatus?.providers ?? [])) {
    if (canonicalModelAuthProviderId(entry.provider) !== canonical) {
      continue;
    }
    for (const profile of entry.profiles) {
      const key = normalizeLowercaseStringOrEmpty(profile.profileId);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      options.push({
        value: profile.profileId,
        label: formatAuthPinProfileLabel(profile),
        type: profile.type,
        cliSubscription: profile.cliSubscription,
      });
    }
  }
  const selected = normalizeOptionalString(selectedProfileId);
  if (selected && !seen.has(normalizeLowercaseStringOrEmpty(selected))) {
    options.unshift({
      value: selected,
      label: selected,
      type: "api_key",
    });
  }
  return options;
}

export function collectPinnedProviderIds(profiles: Record<string, string>): Set<string> {
  const pinned = new Set<string>();
  for (const [provider, profileId] of Object.entries(profiles)) {
    if (!normalizeOptionalString(provider) || !normalizeOptionalString(profileId)) {
      continue;
    }
    pinned.add(canonicalModelAuthProviderId(provider));
  }
  return pinned;
}

export function resolveModelProviderId(modelRef: string | null | undefined): string | null {
  const trimmed = normalizeOptionalString(modelRef);
  if (!trimmed) {
    return null;
  }
  const separator = trimmed.indexOf("/");
  if (separator <= 0) {
    return null;
  }
  return canonicalModelAuthProviderId(trimmed.slice(0, separator));
}

export function orderModelOptionsForAuthPins(
  options: readonly ModelPickerOption[],
  pinnedProviders: ReadonlySet<string>,
  separatorLabel: string,
): ModelPickerOption[] {
  if (pinnedProviders.size === 0) {
    return [...options];
  }
  const inherit: ModelPickerOption[] = [];
  const primary: ModelPickerOption[] = [];
  const other: ModelPickerOption[] = [];
  for (const option of options) {
    if (!option.value) {
      inherit.push(option);
      continue;
    }
    const provider =
      normalizeOptionalString(option.provider) ?? resolveModelProviderId(option.value);
    if (provider && pinnedProviders.has(canonicalModelAuthProviderId(provider))) {
      primary.push(option);
    } else {
      other.push(option);
    }
  }
  if (primary.length === 0 || other.length === 0) {
    return [...inherit, ...primary, ...other];
  }
  return [
    ...inherit,
    ...primary,
    {
      value: OTHER_PROVIDERS_SEPARATOR,
      label: separatorLabel,
      disabled: true,
    },
    ...other,
  ];
}

export function modelNeedsAuthPinHint(
  modelRef: string | null | undefined,
  pinnedProviders: ReadonlySet<string>,
): boolean {
  if (pinnedProviders.size === 0) {
    return false;
  }
  const provider = resolveModelProviderId(modelRef);
  return Boolean(provider && !pinnedProviders.has(provider));
}

/** Prefer a newly appeared non-CLI profile for the auth provider after setup. */
export function findNewAuthProfilePin(params: {
  before: ModelAuthStatusResult | null;
  after: ModelAuthStatusResult;
  providerHint?: string | null;
  modelRef?: string | null;
}): { provider: string; profileId: string } | null {
  const beforeIds = new Set<string>();
  for (const provider of params.before?.providers ?? []) {
    for (const profile of provider.profiles) {
      beforeIds.add(normalizeLowercaseStringOrEmpty(profile.profileId));
    }
  }
  const hint =
    normalizeOptionalString(params.providerHint) ?? resolveModelProviderId(params.modelRef);
  const hintCanonical = hint ? canonicalModelAuthProviderId(hint) : null;
  const candidates: Array<{ provider: string; profileId: string; score: number }> = [];
  for (const provider of listEffectiveModelAuthProviders(params.after.providers)) {
    const providerId = canonicalModelAuthProviderId(provider.provider);
    for (const profile of provider.profiles) {
      if (beforeIds.has(normalizeLowercaseStringOrEmpty(profile.profileId))) {
        continue;
      }
      if (profile.cliSubscription) {
        continue;
      }
      let score = 0;
      if (hintCanonical && providerId === hintCanonical) {
        score += 4;
      }
      if (profile.type === "oauth" || profile.type === "token") {
        score += 2;
      } else if (profile.type === "api_key") {
        score += 1;
      }
      candidates.push({ provider: providerId, profileId: profile.profileId, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  return best ? { provider: best.provider, profileId: best.profileId } : null;
}
