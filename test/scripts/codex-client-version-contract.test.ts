// Codex Client Version Contract tests cover cross-plugin managed version alignment.
import fs from "node:fs";
import { valid as validSemver } from "semver";
import { describe, expect, it } from "vitest";

const CODEX_PACKAGE_JSON_URL = new URL("../../extensions/codex/package.json", import.meta.url);
const OPENAI_CODEX_CLIENT_VERSION_URL = new URL(
  "../../extensions/openai/codex-client-version.ts",
  import.meta.url,
);
const OPENAI_CODEX_CLIENT_VERSION_PATTERN =
  /^export const OPENAI_CODEX_CLIENT_VERSION = "([^"]+)";$/mu;

function readManagedCodexVersion(): string {
  const packageJson = JSON.parse(fs.readFileSync(CODEX_PACKAGE_JSON_URL, "utf8")) as {
    dependencies?: Record<string, unknown>;
  };
  const version = packageJson.dependencies?.["@openai/codex"];
  if (typeof version !== "string" || validSemver(version) !== version) {
    throw new Error("extensions/codex/package.json must pin @openai/codex exactly");
  }
  return version;
}

function readOpenAICodexClientVersion(): string {
  const versionSource = fs.readFileSync(OPENAI_CODEX_CLIENT_VERSION_URL, "utf8");
  const version = OPENAI_CODEX_CLIENT_VERSION_PATTERN.exec(versionSource)?.[1];
  if (!version) {
    throw new Error(
      "extensions/openai/codex-client-version.ts must export the Codex client version",
    );
  }
  return version;
}

describe("Codex client version contract", () => {
  it("matches the shared OpenAI discovery and transport version to the exact managed Codex pin", () => {
    expect(readOpenAICodexClientVersion()).toBe(readManagedCodexVersion());
  });
});
