import assert from "node:assert/strict";
import { test } from "node:test";
import { deployRender } from "./deploy.mjs";

const source = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const image = `public.ecr.aws/p9u4c4e7/openclaw-gateway@${digest}`;
const env = {
  GITHUB_REPOSITORY: "aaron-agent-corporation/openclaw",
  GITHUB_REF: "refs/heads/main",
  SOURCE_SHA: source,
  IMAGE_URL: image,
  RENDER_SERVICE_ID: "srv-dacu5ru1egvs7390isd0",
  RENDER_API_KEY: "test-render-key",
  GH_TOKEN: "test-github-key",
};
function fixture({
  main = source,
  status = "live",
  liveDigest = digest,
  failPost = false,
  pending = false,
  alreadyLive = false,
} = {}) {
  const calls = [];
  const messages = [];
  let time = 0;
  let service = {
    ownerId: "owner-1",
    imagePath: alreadyLive ? image : "public.ecr.aws/p9u4c4e7/openclaw-gateway:previous",
    registryCredential: { id: "credential-1" },
    suspended: "not_suspended",
  };
  const run = (overrides = {}) =>
    deployRender({
      env: { ...env, ...overrides },
      timeoutMs: 20_000,
      now: () => time,
      sleep: async (delay) => {
        time += delay;
      },
      report: (message) => messages.push(message),
      fetchImpl: async (url, options) => {
        calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
        let data;
        if (url.includes("api.github.com")) data = { sha: main };
        else if (url.endsWith("/deploys?limit=20"))
          data = [
            {
              deploy: {
                id: "old-deploy",
                status: pending ? "queued" : "live",
                image: {
                  ref: service.imagePath,
                  sha: alreadyLive ? digest : `sha256:${"c".repeat(64)}`,
                },
              },
            },
          ];
        else if (options.method === "PATCH") {
          service = { ...service, imagePath: JSON.parse(options.body).image.imagePath };
          data = service;
        } else if (options.method === "POST") {
          if (failPost) throw new Error("Lost response after server may have accepted the write");
          data = { id: "new-deploy" };
        } else if (url.endsWith("/deploys/new-deploy"))
          data = { id: "new-deploy", status, image: { ref: image, sha: liveDigest } };
        else data = service;
        return new Response(JSON.stringify(data), { status: 200 });
      },
    });
  return { run, calls, messages };
}

test("stages the digest, preserves registry credential, deploys once, and verifies live digest", async () => {
  const { run, calls, messages } = fixture();
  assert.equal((await run()).id, "new-deploy");
  assert.deepEqual(
    calls.filter((call) => call.method !== "GET").map(({ method, body }) => ({ method, body })),
    [
      {
        method: "PATCH",
        body: {
          image: { imagePath: image, ownerId: "owner-1", registryCredentialId: "credential-1" },
        },
      },
      { method: "POST", body: { imageUrl: image, clearCache: "do_not_clear" } },
    ],
  );
  assert(messages.some((message) => message.includes("gateway:previous")));
  assert(!messages.join("\n").includes("test-render-key"));
});

test("rejects stale sources before touching Render", async () => {
  const { run, calls } = fixture({ main: "d".repeat(40) });
  await assert.rejects(run(), /no longer current main/);
  assert.equal(calls.length, 1);
});

test("rejects other workflow branches and image repositories before network access", async () => {
  const { run, calls } = fixture();
  await assert.rejects(run({ GITHUB_REF: "refs/heads/other" }), /main branch/);
  await assert.rejects(run({ IMAGE_URL: "public.ecr.aws/other/image@" + digest }), /expected ECR/);
  assert.equal(calls.length, 0);
});

test("does not overlap an active Render deploy", async () => {
  const { run, calls } = fixture({ pending: true });
  await assert.rejects(run(), /active deployment/);
  assert(calls.every((call) => call.method === "GET"));
});

test("an uncertain POST is never retried or rolled back", async () => {
  const { run, calls, messages } = fixture({ failPost: true });
  await assert.rejects(run(), /Write outcome is unknown/);
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 1);
  assert(messages.some((message) => message.includes("Previous configured image")));
});

for (const options of [
  { status: "update_failed" },
  { liveDigest: `sha256:${"e".repeat(64)}` },
  { status: "update_in_progress" },
]) {
  test(`failure remains visible without rollback: ${JSON.stringify(options)}`, async () => {
    const { run, calls } = fixture(options);
    await assert.rejects(run(), /No rollback was attempted/);
    assert.equal(calls.filter((call) => call.method === "PATCH").length, 1);
    assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  });
}

test("rerunning an already-live digest does not cause another deployment", async () => {
  const { run, calls } = fixture({ alreadyLive: true });
  assert.equal((await run()).id, "old-deploy");
  assert(calls.every((call) => call.method === "GET"));
});
