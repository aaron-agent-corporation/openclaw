const fs = require("fs");
const { spawn } = require("child_process");
const cfgPath = "/data/.openclaw/openclaw.json";
const SANDBOX_ORIGIN = "https://openclaw-widgets.agent-corporation.com";
const DEVICE_PAIR_URL = "wss://openclaw-pair.agent-corporation.com";
const PUBLIC_ORIGIN = "https://openclaw.agent-corporation.com";
try {
  const j = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  j.plugins = j.plugins || {};
  j.plugins.entries = j.plugins.entries || {};
  j.plugins.entries.codex = j.plugins.entries.codex || {};
  j.plugins.entries.codex.config = j.plugins.entries.codex.config || {};
  j.plugins.entries.codex.config.appServer = j.plugins.entries.codex.config.appServer || {};
  j.plugins.entries.codex.config.appServer.homeScope = "agent";
  j.mcp = j.mcp || {};
  j.mcp.apps = j.mcp.apps || {};
  j.mcp.apps.sandboxOrigin = SANDBOX_ORIGIN;
  j.gateway = j.gateway || {};
  j.gateway.publicOrigin = PUBLIC_ORIGIN;
  j.plugins.entries["device-pair"] = j.plugins.entries["device-pair"] || {};
  j.plugins.entries["device-pair"].enabled = true;
  j.plugins.entries["device-pair"].config = j.plugins.entries["device-pair"].config || {};
  const beforePair = j.plugins.entries["device-pair"].config.publicUrl || null;
  j.plugins.entries["device-pair"].config.publicUrl = DEVICE_PAIR_URL;
  fs.writeFileSync(cfgPath, JSON.stringify(j, null, 2) + "\n");
  console.log(
    "[openclaw-prestart] devicePairPublicUrl before=" + beforePair + " after=" + DEVICE_PAIR_URL,
  );
} catch (err) {
  console.error("[openclaw-prestart] config ensure failed", err);
}
const child = spawn("node", ["/data/bin/openclaw-secure-entrypoint.mjs"], { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code == null ? 1 : code);
});
