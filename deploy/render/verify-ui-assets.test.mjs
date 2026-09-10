import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { verifyUiAssets } from "./verify-ui-assets.mjs";

function fixture() {
  const bodies = new Map([
    ["assets/index.js", 'import "./app.js";'],
    ["assets/app.js", 'customElements.define("openclaw-app", class extends HTMLElement {});'],
    ["assets/index.css", "body { margin: 0; }"],
  ]);
  const manifest = {
    version: 1,
    assets: [...bodies].map(([path, body]) => ({
      path,
      size: Buffer.byteLength(body),
      sha256: createHash("sha256").update(body).digest("hex"),
    })),
  };
  const requests = [];
  const options = {
    base: "http://127.0.0.1:12345",
    html: '<script type="module" src="./assets/index.js"></script>',
    manifest,
    fetchImpl: async (url) => {
      requests.push(url.pathname);
      const body = bodies.get(url.pathname.slice(1));
      return new Response(body ?? "Missing", {
        status: body === undefined ? 404 : 200,
        headers: {
          "content-type": url.pathname.endsWith(".js") ? "text/javascript" : "text/css",
        },
      });
    },
  };
  return { bodies, requests, options };
}

test("accepts a tiny entry facade and verifies its application chunks and stylesheet", async () => {
  const { options, requests } = fixture();
  assert.equal(await verifyUiAssets(options), 3);
  assert.deepEqual(requests, ["/assets/index.js", "/assets/app.js", "/assets/index.css"]);
});

test("rejects a missing application chunk even when the entry is served", async () => {
  const { options, bodies } = fixture();
  bodies.delete("assets/app.js");
  await assert.rejects(verifyUiAssets(options), /asset unavailable: assets\/app.js/);
});

test("rejects same-length corrupted bytes", async () => {
  const { options, bodies } = fixture();
  bodies.set("assets/index.js", 'import "./bad.js";');
  await assert.rejects(verifyUiAssets(options), /asset digest mismatch/);
});

test("rejects an empty entry in the image manifest", async () => {
  const { options } = fixture();
  options.manifest.assets[0].size = 0;
  await assert.rejects(verifyUiAssets(options), /Empty built Control UI asset/);
});

test("rejects an entry absent from the image inventory", async () => {
  const { options } = fixture();
  options.manifest.assets.shift();
  await assert.rejects(verifyUiAssets(options), /entry is absent/);
});

test("rejects cross-origin entries before making requests", async () => {
  const { options, requests } = fixture();
  options.html = '<script src="https://example.com/app.js"></script>';
  await assert.rejects(verifyUiAssets(options), /entry must be served by this gateway/);
  assert.equal(requests.length, 0);
});

test("rejects a startup preload absent from the image inventory", async () => {
  const { options } = fixture();
  options.html += '<link rel="modulepreload" href="./assets/missing.js">';
  await assert.rejects(verifyUiAssets(options), /Startup asset is absent/);
});

test("rejects an HTML fallback served at an asset URL", async () => {
  const { options } = fixture();
  options.fetchImpl = async () =>
    new Response("<html></html>", { headers: { "content-type": "text/html" } });
  await assert.rejects(verifyUiAssets(options), /Unexpected Control UI asset type/);
});
