import { spawn } from "node:child_process";
// Code-KG cache warmer for the OpenClaw secure entrypoint.
//
// Why: the Code-KG Stop check spawns a fresh process that validates the fresh
// graph cache against an implementation fingerprint of its own built dist. After
// a container boot the page cache is cold, and after a dist rebuild the whole
// graph is re-extracted (~2 min on roscoe). Either way the first native Stop
// would exceed the 7.5 s relay deadline and take the revise/map path. This
// module runs the exact Stop check once at boot and again whenever the built
// dist changes, so a live turn never pays that cost.
//
// Best effort by design: warm processes are not tracked children of the
// entrypoint, failures only log, and nothing here can block gateway startup.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const CONFIG_PATH = "/data/.openclaw/openclaw.json";
const WARM_TIMEOUT_MS = 300000;

export function readCodeKgConfig(configPath = CONFIG_PATH) {
  const entry = JSON.parse(readFileSync(configPath, "utf8"))?.plugins?.entries?.["code-kg"];
  const config = entry?.config;
  if (
    entry?.enabled !== true ||
    typeof config?.codekgRoot !== "string" ||
    typeof config?.repository !== "string"
  ) {
    return null;
  }
  return { codekgRoot: config.codekgRoot, repository: config.repository };
}

// mtime+size over the built runtime tree: a rebuild always changes this, and it
// is cheap enough to poll on a network disk.
export function distFingerprint(codekgRoot) {
  const parts = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        const info = statSync(path);
        parts.push(`${path}:${info.size}:${Math.floor(info.mtimeMs)}`);
      }
    }
  };
  walk(join(codekgRoot, "dist", "src"));
  for (const file of ["package.json", "pnpm-lock.yaml", "package-lock.json"]) {
    try {
      const info = statSync(join(codekgRoot, file));
      parts.push(`${file}:${info.size}:${Math.floor(info.mtimeMs)}`);
    } catch {}
  }
  return parts.join("\n");
}

export function warmCodeKg({
  config,
  env,
  log = console,
  timeoutMs = WARM_TIMEOUT_MS,
  reason = "boot",
}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(
      process.execPath,
      [
        join(config.codekgRoot, "dist/src/codekg/cli.js"),
        "--dir",
        config.repository,
        "--no-color",
        "agent-context",
        "stop",
      ],
      {
        cwd: config.repository,
        env: { ...env, CODEKG_AGENT_ROLE: "orchestrator", NO_COLOR: "1" },
        stdio: ["pipe", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    const killer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    killer.unref();
    child.once("exit", (code, signal) => {
      clearTimeout(killer);
      const ms = Date.now() - startedAt;
      if (code === 0)
        log.log(
          `[secure-entrypoint] code-kg warm (${reason}) complete in ${ms}ms (${config.repository})`,
        );
      else
        log.error(
          `[secure-entrypoint] code-kg warm (${reason}) failed (code=${code}, signal=${signal}, ${ms}ms) ${stderr.trim()}`,
        );
      resolve(code === 0);
    });
    child.once("error", (err) => {
      log.error("[secure-entrypoint] code-kg warm spawn failed", err?.message ?? err);
      resolve(false);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(
      JSON.stringify({
        agent: "claude",
        session_id: "entrypoint-warm",
        cwd: config.repository,
        stop_hook_active: true,
      }),
    );
  });
}

/**
 * Warm once now, then poll the built dist; when its fingerprint changes and
 * stays unchanged for `settleMs` (a build in progress keeps changing it), warm
 * again. Warms never overlap. Returns a stop function.
 */
export function startCodeKgWarmWatcher({
  configPath = CONFIG_PATH,
  env,
  log = console,
  intervalMs = 30000,
  settleMs = 20000,
} = {}) {
  let known = null; // fingerprint the current cache corresponds to
  let candidate = null; // changed fingerprint waiting to settle
  let candidateSince = 0;
  let running = null; // in-flight warm promise
  let rerun = false; // change observed while a warm was running

  const runWarm = (config, reason) => {
    if (running) {
      rerun = true;
      return running;
    }
    running = warmCodeKg({ config, env, log, reason }).finally(() => {
      running = null;
      if (rerun) {
        rerun = false;
        candidate = null;
      }
    });
    return running;
  };

  const tick = () => {
    let config;
    try {
      config = readCodeKgConfig(configPath);
    } catch (err) {
      log.error("[secure-entrypoint] code-kg warm skipped: config unreadable", err?.message ?? err);
      return;
    }
    if (!config) {
      if (known === null)
        log.log("[secure-entrypoint] code-kg warm skipped: plugin not enabled or not configured");
      known = "";
      return;
    }
    const current = distFingerprint(config.codekgRoot);
    if (known === null || known === "") {
      known = current;
      candidate = null;
      void runWarm(config, "boot");
      return;
    }
    if (current === known) {
      candidate = null;
      return;
    }
    if (current !== candidate) {
      candidate = current;
      candidateSince = Date.now();
      return;
    }
    if (Date.now() - candidateSince < settleMs) return;
    known = current;
    candidate = null;
    log.log("[secure-entrypoint] code-kg dist changed; re-warming cache");
    void runWarm(config, "rebuild");
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
