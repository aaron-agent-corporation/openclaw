import { html, nothing } from "lit";
import type { ModelAuthStatusResult, SystemAgentSetupDetectResult } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { canonicalModelAuthProviderId } from "../../lib/model-auth.ts";
import {
  createAuthPinDraft,
  listAuthPinProfileOptions,
  listAuthPinProviderOptions,
  type AgentAuthPinDraft,
} from "./auth-pins.ts";

type AuthOption = NonNullable<SystemAgentSetupDetectResult["authOptions"]>[number];
type ManualProvider = SystemAgentSetupDetectResult["manualProviders"][number];

export function renderAgentAuthPinsPanel(params: {
  agentId: string;
  authProfiles: Record<string, string>;
  drafts: readonly AgentAuthPinDraft[];
  authStatus: ModelAuthStatusResult | null;
  authStatusError: string | null;
  disabled: boolean;
  subscriptionPanel: "closed" | "pick" | "api-key";
  authOptions: readonly AuthOption[];
  manualProviders: readonly ManualProvider[];
  apiKeyProviderId: string;
  apiKeyValue: string;
  subscriptionBusy: boolean;
  onAuthProfilesChange: (agentId: string, profiles: Record<string, string>) => void;
  onDraftsChange: (drafts: AgentAuthPinDraft[]) => void;
  onOpenSubscriptionPanel: () => void;
  onCloseSubscriptionPanel: () => void;
  onStartAuth: (authChoiceId: string, providerHint?: string | null) => void;
  onShowApiKeyForm: () => void;
  onApiKeyProviderChange: (providerId: string) => void;
  onApiKeyValueChange: (value: string) => void;
  onSaveApiKey: () => void;
  onAuthStatusRetry: () => void;
}) {
  const committedEntries = Object.entries(params.authProfiles).filter(
    ([provider, profileId]) => Boolean(provider.trim()) && Boolean(profileId.trim()),
  );
  const providerOptions = listAuthPinProviderOptions(
    params.authStatus,
    committedEntries.map(([provider]) => provider),
  );
  const commitProfiles = (next: Record<string, string>) => {
    params.onAuthProfilesChange(params.agentId, next);
  };

  const updateCommitted = (previousProvider: string, nextProvider: string, profileId: string) => {
    const next = { ...params.authProfiles };
    delete next[previousProvider];
    const provider = nextProvider.trim();
    const profile = profileId.trim();
    if (provider && profile) {
      next[canonicalModelAuthProviderId(provider)] = profile;
    }
    commitProfiles(next);
  };

  const renderPinRow = (args: {
    key: string;
    provider: string;
    profileId: string;
    draftId?: string;
  }) => {
    const profiles = listAuthPinProfileOptions(params.authStatus, args.provider, args.profileId);
    const providers =
      args.provider && !providerOptions.some((option) => option.value === args.provider)
        ? [...providerOptions, { value: args.provider, label: args.provider }]
        : providerOptions;
    return html`
      <div class="agent-auth-pins__row" data-auth-pin-row=${args.key}>
        <label class="field">
          <span>${t("agents.overview.authPinProvider")}</span>
          <select
            ?disabled=${params.disabled}
            .value=${args.provider}
            @change=${(e: Event) => {
              // SAFETY: change handler is bound to this <select>.
              const nextProvider = (e.target as HTMLSelectElement).value;
              if (args.draftId) {
                params.onDraftsChange(
                  params.drafts.map((draft) =>
                    draft.draftId === args.draftId
                      ? { ...draft, provider: nextProvider, profileId: "" }
                      : draft,
                  ),
                );
                return;
              }
              updateCommitted(args.provider, nextProvider, "");
            }}
          >
            <option value="">${t("agents.overview.authPinSelectProvider")}</option>
            ${providers.map(
              (option) => html`
                <option value=${option.value} ?selected=${option.value === args.provider}>
                  ${option.label}
                </option>
              `,
            )}
          </select>
        </label>
        <label class="field">
          <span>${t("agents.overview.authPinProfile")}</span>
          <select
            ?disabled=${params.disabled || !args.provider}
            .value=${args.profileId}
            @change=${(e: Event) => {
              // SAFETY: change handler is bound to this <select>.
              const nextProfile = (e.target as HTMLSelectElement).value.trim();
              if (args.draftId) {
                if (!args.provider || !nextProfile) {
                  params.onDraftsChange(
                    params.drafts.map((draft) =>
                      draft.draftId === args.draftId ? { ...draft, profileId: nextProfile } : draft,
                    ),
                  );
                  return;
                }
                const next = { ...params.authProfiles };
                next[canonicalModelAuthProviderId(args.provider)] = nextProfile;
                commitProfiles(next);
                params.onDraftsChange(
                  params.drafts.filter((draft) => draft.draftId !== args.draftId),
                );
                return;
              }
              updateCommitted(args.provider, args.provider, nextProfile);
            }}
          >
            <option value="">${t("agents.overview.authPinSelectProfile")}</option>
            ${profiles.map(
              (option) => html`
                <option value=${option.value} ?selected=${option.value === args.profileId}>
                  ${option.label}
                </option>
              `,
            )}
          </select>
        </label>
        <button
          type="button"
          class="btn btn--sm"
          ?disabled=${params.disabled}
          @click=${() => {
            if (args.draftId) {
              params.onDraftsChange(
                params.drafts.filter((draft) => draft.draftId !== args.draftId),
              );
              return;
            }
            const next = { ...params.authProfiles };
            delete next[args.provider];
            commitProfiles(next);
          }}
        >
          ${args.draftId ? t("common.cancel") : t("agents.overview.authPinRemove")}
        </button>
      </div>
    `;
  };

  return html`
    <div class="agent-auth-pins">
      ${params.authStatusError
        ? html`
            <div class="callout warn" role="status">
              ${params.authStatusError}
              <button type="button" class="btn btn--sm" @click=${params.onAuthStatusRetry}>
                ${t("common.retry")}
              </button>
            </div>
          `
        : nothing}
      ${committedEntries.map(([provider, profileId]) =>
        renderPinRow({
          key: `pin:${provider}`,
          provider,
          profileId,
        }),
      )}
      ${params.drafts.map((draft) =>
        renderPinRow({
          key: `draft:${draft.draftId}`,
          provider: draft.provider,
          profileId: draft.profileId,
          draftId: draft.draftId,
        }),
      )}
      <div class="agent-auth-pins__actions">
        <button
          type="button"
          class="btn btn--sm"
          ?disabled=${params.disabled}
          @click=${() => {
            params.onDraftsChange([
              ...params.drafts,
              createAuthPinDraft(params.drafts, params.authProfiles),
            ]);
          }}
        >
          ${t("agents.overview.authPinAdd")}
        </button>
        <button
          type="button"
          class="btn btn--sm primary"
          ?disabled=${params.disabled || params.subscriptionBusy}
          @click=${params.onOpenSubscriptionPanel}
        >
          ${t("agents.overview.authPinAddSubscription")}
        </button>
      </div>
      ${params.subscriptionPanel === "closed"
        ? nothing
        : html`
            <div class="agent-auth-pins__subscription" data-auth-subscription-panel>
              <div class="agent-auth-pins__subscription-header">
                <strong>${t("agents.overview.authPinAddSubscriptionTitle")}</strong>
                <button
                  type="button"
                  class="btn btn--sm"
                  ?disabled=${params.subscriptionBusy}
                  @click=${params.onCloseSubscriptionPanel}
                >
                  ${t("common.close")}
                </button>
              </div>
              ${params.subscriptionPanel === "pick"
                ? html`
                    <p class="muted">${t("agents.overview.authPinAddSubscriptionHelp")}</p>
                    <div class="agent-auth-pins__subscription-list">
                      ${params.authOptions.map(
                        (option) => html`
                          <button
                            type="button"
                            class="btn"
                            ?disabled=${params.subscriptionBusy}
                            data-auth-choice=${option.id}
                            @click=${() =>
                              params.onStartAuth(option.id, option.brandId ?? option.groupLabel)}
                          >
                            ${option.groupLabel
                              ? html`${option.groupLabel} — ${option.label}`
                              : option.label}
                          </button>
                        `,
                      )}
                      ${params.manualProviders.length > 0
                        ? html`
                            <button
                              type="button"
                              class="btn"
                              ?disabled=${params.subscriptionBusy}
                              @click=${params.onShowApiKeyForm}
                            >
                              ${t("agents.overview.authPinAddApiKey")}
                            </button>
                          `
                        : nothing}
                      ${params.authOptions.length === 0 && params.manualProviders.length === 0
                        ? html`<div class="muted">
                            ${t("agents.overview.authPinAddSubscriptionEmpty")}
                          </div>`
                        : nothing}
                    </div>
                  `
                : html`
                    <label class="field">
                      <span>${t("agents.overview.authPinProvider")}</span>
                      <select
                        ?disabled=${params.subscriptionBusy}
                        .value=${params.apiKeyProviderId}
                        @change=${(e: Event) =>
                          // SAFETY: change handler is bound to this <select>.
                          params.onApiKeyProviderChange((e.target as HTMLSelectElement).value)}
                      >
                        <option value="">${t("agents.overview.authPinSelectProvider")}</option>
                        ${params.manualProviders.map(
                          (provider) => html`
                            <option
                              value=${provider.id}
                              ?selected=${provider.id === params.apiKeyProviderId}
                            >
                              ${provider.groupLabel
                                ? `${provider.groupLabel} — ${provider.label}`
                                : provider.label}
                            </option>
                          `,
                        )}
                      </select>
                    </label>
                    <label class="field">
                      <span>${t("agents.overview.authPinApiKey")}</span>
                      <input
                        type="password"
                        autocomplete="off"
                        ?disabled=${params.subscriptionBusy}
                        .value=${params.apiKeyValue}
                        @input=${(e: Event) =>
                          // SAFETY: input handler is bound to this password field.
                          params.onApiKeyValueChange((e.target as HTMLInputElement).value)}
                      />
                    </label>
                    <div class="agent-auth-pins__actions">
                      <button
                        type="button"
                        class="btn btn--sm"
                        ?disabled=${params.subscriptionBusy}
                        @click=${params.onOpenSubscriptionPanel}
                      >
                        ${t("common.back")}
                      </button>
                      <button
                        type="button"
                        class="btn btn--sm primary"
                        ?disabled=${params.subscriptionBusy ||
                        !params.apiKeyProviderId ||
                        !params.apiKeyValue.trim()}
                        @click=${params.onSaveApiKey}
                      >
                        ${t("agents.overview.authPinSaveApiKey")}
                      </button>
                    </div>
                  `}
            </div>
          `}
    </div>
  `;
}
