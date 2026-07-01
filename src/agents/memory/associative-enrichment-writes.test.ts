// Phase 5 (05-01) tests for the core-owned enrichment WRITE surface: the memory-core
// dreaming pass persists importance / rollups / summary_embedding_ref / DAG edges /
// box auto-expand through these validated wrappers, and core keeps schema ownership.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import {
  autoExpandBox,
  linkTagParent,
  writeBoxEnrichment,
} from "./associative-enrichment-writes.js";
import { upsertMemoryTag } from "./associative-store.js";
import { listBoxes, upsertBox } from "./turns-store.js";

function createTempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-enrichment-writes-"));
}

function scope(stateDir: string) {
  return {
    agentId: "main",
    sessionKey: "agent:main:main",
    env: { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv,
  };
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

describe("associative-enrichment-writes", () => {
  it("populates importance / summary_embedding_ref / suppression_rollup without clobbering label", () => {
    const s = scope(createTempStateDir());
    upsertBox({ ...s, box: { boxId: "box-1", sessionKey: s.sessionKey, label: "Memory" } });

    writeBoxEnrichment({
      ...s,
      box: {
        boxId: "box-1",
        sessionKey: s.sessionKey,
        importance: 0.72,
        summary: "Rollup of the memory topic",
        summaryEmbeddingRef: "emb:box-1:v1",
        suppressionRollup: "collapsed-earlier",
      },
    });

    const [box] = listBoxes({ ...s, sessionKey: s.sessionKey });
    expect(box).toMatchObject({
      box_id: "box-1",
      label: "Memory",
      importance: 0.72,
      summary: "Rollup of the memory topic",
      summary_embedding_ref: "emb:box-1:v1",
      suppression_rollup: "collapsed-earlier",
    });
    expect(box.importance).not.toBeNull();
    expect(box.summary_embedding_ref).not.toBeNull();
    expect(box.suppression_rollup).not.toBeNull();
  });

  it("is idempotent — re-running with identical inputs leaves the same row", () => {
    const s = scope(createTempStateDir());
    upsertBox({ ...s, box: { boxId: "box-1", sessionKey: s.sessionKey, label: "Memory" } });
    const enrichment = {
      boxId: "box-1",
      sessionKey: s.sessionKey,
      importance: 0.5,
      summary: "stable",
      summaryEmbeddingRef: "emb:1",
    };
    writeBoxEnrichment({ ...s, box: enrichment });
    const first = listBoxes({ ...s, sessionKey: s.sessionKey })[0];
    writeBoxEnrichment({ ...s, box: enrichment });
    const second = listBoxes({ ...s, sessionKey: s.sessionKey })[0];
    expect(second).toEqual(first);
  });

  it("rejects importance outside [0,1]", () => {
    const s = scope(createTempStateDir());
    upsertBox({ ...s, box: { boxId: "box-1", sessionKey: s.sessionKey, label: "Memory" } });
    expect(() =>
      writeBoxEnrichment({
        ...s,
        box: { boxId: "box-1", sessionKey: s.sessionKey, importance: 1.5 },
      }),
    ).toThrow(/importance/);
    expect(() =>
      writeBoxEnrichment({
        ...s,
        box: { boxId: "box-1", sessionKey: s.sessionKey, importance: -0.1 },
      }),
    ).toThrow(/importance/);
  });

  it("rejects blank ids before touching the DB", () => {
    const s = scope(createTempStateDir());
    expect(() =>
      writeBoxEnrichment({ ...s, box: { boxId: "  ", sessionKey: s.sessionKey } }),
    ).toThrow(/boxId/);
  });

  it("autoExpandBox flips a collapsed box to live", () => {
    const s = scope(createTempStateDir());
    upsertBox({
      ...s,
      box: { boxId: "box-1", sessionKey: s.sessionKey, label: "Memory", state: "collapsed" },
    });
    autoExpandBox({ ...s, boxId: "box-1" });
    const [box] = listBoxes({ ...s, sessionKey: s.sessionKey });
    expect(box.state).toBe("live");
  });

  it("linkTagParent preserves the cycle guard", () => {
    const s = scope(createTempStateDir());
    upsertMemoryTag({ ...s, tag: { tagId: "tag-a", label: "A" } });
    upsertMemoryTag({ ...s, tag: { tagId: "tag-b", label: "B" } });
    linkTagParent({ ...s, childTagId: "tag-a", parentTagId: "tag-b" });
    expect(() => linkTagParent({ ...s, childTagId: "tag-b", parentTagId: "tag-a" })).toThrow(
      /cycle/,
    );
  });
});
