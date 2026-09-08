import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
// Stage agents.entries.<id>.auth.profiles pins against the runtime config form.
import type { ApplicationContext } from "../../app/context.ts";

type RuntimeConfig = ApplicationContext["runtimeConfig"];

/** Stage the full provider→profile pin map for an agent (empty clears). */
export function stageAgentAuthProfiles(
  runtimeConfig: RuntimeConfig,
  agentId: string,
  profiles: Record<string, string>,
) {
  const cleaned: Record<string, string> = {};
  for (const [provider, profileId] of Object.entries(profiles)) {
    const providerKey = normalizeOptionalString(provider);
    const profile = normalizeOptionalString(profileId);
    if (providerKey && profile) {
      cleaned[providerKey] = profile;
    }
  }
  const ensure = Object.keys(cleaned).length > 0;
  const target = runtimeConfig.agentEntry(agentId, { ensure });
  if (!target) {
    return;
  }
  if (Object.keys(cleaned).length === 0) {
    runtimeConfig.removeFormValue([...target.path, "auth"]);
    return;
  }
  runtimeConfig.patchForm([...target.path, "auth"], { profiles: cleaned });
}
