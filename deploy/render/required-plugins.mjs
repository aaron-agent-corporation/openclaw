// Preserve the configured Render plugin inventory, plus its diagnostics build.
// Selecting core plugins explicitly also retains them if upstream externalizes them.
export const REQUIRED_RENDER_PLUGINS = [
  "active-memory",
  "anthropic",
  "browser",
  "canvas",
  "codex",
  "crabbox",
  "device-pair",
  "diagnostics-otel",
  "firecrawl",
  "lobster",
  "memory-wiki",
  "openai",
  "openrouter",
  "tokenjuice",
  "workboard",
];
