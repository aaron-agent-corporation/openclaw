import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { distFingerprint, readCodeKgConfig } from "./openclaw-codekg-warm.mjs";

const root = mkdtempSync(join(tmpdir(), "codekg-warm-"));
test.after(() => rmSync(root, { recursive: true, force: true }));

test("readCodeKgConfig returns the repository binding only for an enabled, configured plugin", () => {
  const configPath = join(root, "openclaw.json");
  const write = (entry) =>
    writeFileSync(configPath, JSON.stringify({ plugins: { entries: { "code-kg": entry } } }));
  write({ enabled: true, config: { codekgRoot: "/kg", repository: "/repo" } });
  assert.deepEqual(readCodeKgConfig(configPath), { codekgRoot: "/kg", repository: "/repo" });
  write({ enabled: false, config: { codekgRoot: "/kg", repository: "/repo" } });
  assert.equal(readCodeKgConfig(configPath), null);
  write({ enabled: true, config: { repository: "/repo" } });
  assert.equal(readCodeKgConfig(configPath), null);
  writeFileSync(configPath, "{}");
  assert.equal(readCodeKgConfig(configPath), null);
});

test("distFingerprint changes when a built file changes and is stable otherwise", () => {
  const kg = join(root, "kg");
  mkdirSync(join(kg, "dist", "src", "codekg"), { recursive: true });
  writeFileSync(join(kg, "dist", "src", "codekg", "cli.js"), "1");
  writeFileSync(join(kg, "package.json"), "{}");
  const before = distFingerprint(kg);
  assert.equal(distFingerprint(kg), before);
  // A rebuild that rewrites identical bytes still moves mtime; that must count.
  utimesSync(join(kg, "dist", "src", "codekg", "cli.js"), new Date(0), new Date(1_700_000_000_000));
  const touched = distFingerprint(kg);
  assert.notEqual(touched, before);
  writeFileSync(join(kg, "dist", "src", "codekg", "cli.js"), "12");
  assert.notEqual(distFingerprint(kg), touched);
  assert.equal(distFingerprint(join(root, "missing")), "");
});
