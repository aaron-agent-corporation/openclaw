// Shared arg handling for the `openclaw memory` command group (backfill, replay-eval).
import { isValidAgentId, normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";

/**
 * Validate the operator-supplied agent id with the canonical `isValidAgentId` (VALID_ID_RE),
 * then return its normalized form. Rejecting up front with the same predicate the rest of the
 * system uses means a malformed id (leading `_`/`-`, path traversal like `../other`, embedded
 * dots) never reaches path/DB resolution (V5 — no traversal before path resolution); we do NOT
 * let `normalizeAgentId` silently coerce a bad id into a different agent's data.
 */
export function resolveCommandAgentId(raw: string | undefined, runtime: RuntimeEnv): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) {
    runtime.error("--agent <id> is required.");
    runtime.exit(1);
    return null;
  }
  if (!isValidAgentId(trimmed)) {
    runtime.error(`Invalid --agent id: ${trimmed}`);
    runtime.exit(1);
    return null;
  }
  return normalizeAgentId(trimmed);
}
