import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export async function verifyUiAssets({ base, html, manifest, fetchImpl = fetch }) {
  const entry = html.match(/<script\b[^>]*\bsrc=["']([^"']+\.js)["']/i)?.[1];
  assert(entry, "Control UI HTML has no JavaScript entry");
  const entryUrl = new URL(entry, `${base}/`);
  assert.equal(entryUrl.origin, base, "Control UI entry must be served by this gateway");
  assert.equal(manifest.version, 1, "Unsupported Control UI asset manifest");
  const assets = manifest.assets.filter((asset) => /\.(?:js|css)$/.test(asset.path));
  assert(
    assets.some((asset) => `/${asset.path}` === entryUrl.pathname),
    "Control UI entry is absent from the image asset manifest",
  );
  const paths = new Set(assets.map((asset) => `/${asset.path}`));
  // Match the startup-reference contract in check-control-ui-performance.mts.
  for (const tag of html.matchAll(/<(?:link|script)\b[^>]*>/giu)) {
    const ref = tag[0].match(/\s(?:href|src)\s*=\s*["']([^"']+)["']/iu)?.[1];
    if (!ref) continue;
    const url = new URL(ref, `${base}/`);
    if (!/\.(?:js|css)$/.test(url.pathname)) continue;
    assert.equal(url.origin, base, "Startup asset must be served by this gateway");
    assert(paths.has(url.pathname), `Startup asset is absent from image manifest: ${url.pathname}`);
  }
  // Vite can emit a tiny entry facade. The build-owned manifest proves exact
  // served bytes for the entry and every emitted JS/CSS chunk, without a size guess.
  for (const asset of assets) {
    assert(asset.path.startsWith("assets/"), "Unexpected Control UI asset path");
    const url = new URL(asset.path, `${base}/`);
    assert.equal(url.origin, base);
    assert.equal(url.pathname, `/${asset.path}`, "Control UI asset path must be canonical");
    assert(asset.size > 0, `Empty built Control UI asset: ${asset.path}`);
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200, `Control UI asset unavailable: ${asset.path}`);
    assert.match(
      response.headers.get("content-type") ?? "",
      asset.path.endsWith(".js") ? /javascript/ : /text\/css/,
      `Unexpected Control UI asset type: ${asset.path}`,
    );
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.byteLength, asset.size, `Control UI asset size mismatch: ${asset.path}`);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      asset.sha256,
      `Control UI asset digest mismatch: ${asset.path}`,
    );
  }
  return assets.length;
}
