#!/usr/bin/env node
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { startCodeKgWarmWatcher } from "/data/bin/openclaw-codekg-warm.mjs";

const publicPort = Number(process.env.PORT || 8080);
const gatewayPort = Number(process.env.OPENCLAW_PRIVATE_PORT || 18789);
let ready = false;
let stopping = false;
const children = new Set();

function start(name, command, args, env) {
  const child = spawn(command, args, { env, stdio: "inherit" });
  children.add(child);
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!stopping) {
      console.error(`[secure-entrypoint] ${name} exited (code=${code}, signal=${signal})`);
      shutdown(code || 1);
    }
  });
  return child;
}

function probeGateway() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: gatewayPort });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(ready ? 200 : 503, { "content-type": "text/plain", "cache-control": "no-store" });
    res.end(ready ? "ok\n" : "starting\n");
    return;
  }
  res.writeHead(404, { "content-type": "text/plain", "cache-control": "no-store" });
  res.end("not found\n");
});
server.listen(publicPort, "0.0.0.0", () => {
  console.log(`[secure-entrypoint] public health endpoint listening on 0.0.0.0:${publicPort}`);
});

const gatewayEnv = {
  ...process.env,
  HOME: "/data",
  PATH: `/data/bin:${process.env.PATH || ""}`,
  OPENCLAW_GATEWAY_PORT: String(gatewayPort),
};
if (process.env.OPENCLAW_TRUSTED_PROXY_READY === "1") {
  delete gatewayEnv.OPENCLAW_GATEWAY_TOKEN;
}

start(
  "openclaw",
  process.execPath,
  [
    "/app/openclaw.mjs",
    "gateway",
    "--allow-unconfigured",
    "--bind",
    "loopback",
    "--port",
    String(gatewayPort),
  ],
  gatewayEnv,
);

// Code-KG cache warm: once at boot and again after any dist rebuild, so the
// first native Stop check never pays the cold/re-extraction cost. See
// /data/bin/openclaw-codekg-warm.mjs (best effort; never blocks startup).
startCodeKgWarmWatcher({ env: gatewayEnv, log: console });

let tunnelStarted = false;
const readinessTimer = setInterval(async () => {
  const gatewayReady = await probeGateway();
  if (gatewayReady && !tunnelStarted) {
    tunnelStarted = true;
    start("cloudflared", "/data/bin/cloudflared", ["tunnel", "--no-autoupdate", "run"], {
      ...process.env,
      HOME: "/data",
      PATH: `/data/bin:${process.env.PATH || ""}`,
    });
  }
  ready = gatewayReady && tunnelStarted;
}, 1000);

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  ready = false;
  clearInterval(readinessTimer);
  server.close();
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
    process.exit(code);
  }, 8000).unref();
  if (children.size === 0) process.exit(code);
}

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
