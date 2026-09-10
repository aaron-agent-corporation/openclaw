import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { verifyUiAssets } from "./verify-ui-assets.mjs";

const image = process.argv[2];
const version = process.env.IMAGE_VERSION;
const sha = process.env.SOURCE_SHA;
assert(image && version && /^[a-f0-9]{40}$/.test(sha), "Image, version, and source SHA required");
const docker = (...args) =>
  execFileSync("docker", args, { encoding: "utf8", timeout: 120_000 }).trim();
const [metadata] = JSON.parse(docker("image", "inspect", image));
assert.equal(metadata.Architecture, "amd64");
assert.equal(metadata.Os, "linux");
assert.equal(metadata.Config.User, "node", "Preserve upstream non-root runtime");
const info = JSON.parse(
  docker(
    "run",
    "--rm",
    "--entrypoint",
    "node",
    image,
    "-e",
    `
  const fs = require('node:fs');
  console.log(JSON.stringify({
    uid: process.getuid(),
    packageVersion: require('/app/package.json').version,
    codexVersion: require('/app/extensions/codex/node_modules/@openai/codex/package.json').version,
    build: JSON.parse(fs.readFileSync('/app/dist/build-info.json', 'utf8'))
  }));
`,
  ),
);
assert.notEqual(info.uid, 0);
assert.equal(info.packageVersion, version);
assert.equal(info.build.version, version);
assert.equal(info.build.commit, sha);
const cli = docker("run", "--rm", image, "node", "openclaw.mjs", "--version");
assert(cli.includes(version), `CLI did not report expected version ${version}`);
console.log(`Image CLI: ${cli}; uid=${info.uid}; commit=${sha}`);
const codexCli = docker(
  "run",
  "--rm",
  "--entrypoint",
  "node",
  image,
  "/app/extensions/codex/node_modules/@openai/codex/bin/codex.js",
  "--version",
);
assert.equal(
  codexCli,
  `codex-cli ${info.codexVersion}`,
  "Managed Codex binary and package versions must match",
);
console.log(`Image managed Codex CLI: ${codexCli}`);

const token = randomBytes(32).toString("hex");
const name = `openclaw-smoke-${process.pid}`;
// This container owns disposable state. Exercise normal startup with bundled
// plugins enabled; disabling startup owners could hide a broken shipped image.
const initialize = `node --input-type=module -e '
  import fs from "node:fs";
  fs.mkdirSync(process.env.OPENCLAW_STATE_DIR, { recursive: true });
  fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify({
    gateway: {
      mode: "local",
      auth: { mode: "token", token: process.env.OPENCLAW_GATEWAY_TOKEN },
      controlUi: { allowedOrigins: ["http://127.0.0.1"] }
    }
  }));
' && exec node openclaw.mjs gateway --bind lan --port 18789`;
try {
  docker(
    "run",
    "--detach",
    "--name",
    name,
    "--publish",
    "127.0.0.1::18789",
    "--env",
    "OPENCLAW_STATE_DIR=/tmp/openclaw-smoke",
    "--env",
    "OPENCLAW_CONFIG_PATH=/tmp/openclaw-smoke/openclaw.json",
    "--env",
    `OPENCLAW_GATEWAY_TOKEN=${token}`,
    image,
    "sh",
    "-c",
    initialize,
  );
  const binding = docker("port", name, "18789/tcp");
  assert.match(binding, /^127\.0\.0\.1:\d+$/);
  const base = `http://${binding}`;
  let ready = false;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    assert.equal(
      docker("inspect", "--format", "{{.State.Running}}", name),
      "true",
      "Gateway exited",
    );
    const response = await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(3000) }).catch(
      () => null,
    );
    if (response?.ok) {
      ready = true;
      break;
    }
    await setTimeout(2000);
  }
  assert(ready, "Gateway /readyz did not become ready within 120 seconds");
  const response = await fetch(`${base}/`, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  const html = await response.text();
  const manifest = JSON.parse(
    docker("exec", name, "cat", "/app/dist/control-ui/asset-manifest.json"),
  );
  const count = await verifyUiAssets({ base, html, manifest });
  console.log(`Image gateway ready; Control UI and ${count} JS/CSS assets match the built image`);
} catch (error) {
  try {
    console.error(docker("logs", "--tail", "100", name).replaceAll(token, "[smoke-token]"));
  } catch {}
  throw error;
} finally {
  docker("rm", "--force", name);
}
