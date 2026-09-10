/**
 * Codex client version OpenClaw advertises on ChatGPT-backend requests.
 *
 * The backend gates newer models on the caller's Codex version, so the direct
 * ChatGPT transport must present the same version as the managed app-server.
 * Keep synchronized with extensions/codex's exact @openai/codex dependency;
 * the provider contract test fails when that managed-runtime pin changes.
 */
export const OPENAI_CODEX_CLIENT_VERSION = "0.154.0-alpha.11";
