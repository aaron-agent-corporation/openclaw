// 05-04 Task 3 / 05-07: the visible `recalled: {topic}` marker + badge (D-02). A box
// auto-expanded by an accordion-aware retrieval match THIS turn is flagged recalled; a
// manually-expanded or already-live box is not, and the flag self-clears once the head seq
// advances (durable recalled_at_seq, not a process-global). The marker text names the topic.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { applyRetrievalAutoExpand } from "./accordion-auto-expand.js";
import { readAccordionView, recalledMarkerText } from "./accordion-ui.js";
import type { AssociativeContext } from "./associative-context.js";
import { appendTurns, upsertBox } from "./turns-store.js";

const AGENT = "main";
const SESSION_KEY = "agent:main:main";
const scope = { agentId: AGENT, sessionKey: SESSION_KEY };
let priorStateDir: string | undefined;

beforeEach(() => {
  priorStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-recalled-"));
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  if (priorStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = priorStateDir;
  }
});

function appendTurn(idempotencyKey: string, content: string): void {
  appendTurns({
    ...scope,
    turns: [{ role: "user", content, contentHash: `h-${idempotencyKey}`, idempotencyKey, ts: 1 }],
  });
}

const recalledContext: AssociativeContext = {
  boxes: [
    {
      boxId: "recalled",
      topic: "Fidel case",
      summary: "Fidel case rollup",
      state: "collapsed",
      tags: [],
      entities: ["Fidel"],
      importance: 0.5,
      summaryEmbeddingRef: null,
      suppressionRollup: null,
    },
  ],
};

describe("recalledMarkerText", () => {
  it("names the topic", () => {
    expect(recalledMarkerText("Fidel case")).toBe("recalled: Fidel case");
  });
  it("falls back when there is no label", () => {
    expect(recalledMarkerText(null)).toBe("recalled: earlier topic");
  });
});

describe("readAccordionView recalled flag", () => {
  it("flags only the retrieval-auto-expanded box, not a plain live box", () => {
    appendTurn("t1", "the Fidel case");
    upsertBox({
      agentId: AGENT,
      box: { boxId: "recalled", sessionKey: SESSION_KEY, label: "Fidel case", state: "collapsed" },
    });
    upsertBox({
      agentId: AGENT,
      box: { boxId: "plain", sessionKey: SESSION_KEY, label: "Voice", state: "live" },
    });
    const decision = applyRetrievalAutoExpand({
      ...scope,
      query: "the Fidel case",
      context: recalledContext,
    });
    expect(decision.decision.expanded).toBe(true);

    const view = readAccordionView(scope);
    expect(view.boxes.find((b) => b.id === "recalled")?.recalled).toBe(true);
    expect(view.boxes.find((b) => b.id === "plain")?.recalled).toBe(false);
  });

  it("self-clears the recalled flag once the head seq advances, while the box stays live", () => {
    appendTurn("t1", "the Fidel case");
    upsertBox({
      agentId: AGENT,
      box: { boxId: "recalled", sessionKey: SESSION_KEY, label: "Fidel case", state: "collapsed" },
    });
    applyRetrievalAutoExpand({ ...scope, query: "the Fidel case", context: recalledContext });
    expect(readAccordionView(scope).boxes.find((b) => b.id === "recalled")?.recalled).toBe(true);

    // A later turn advances the head; the box is still live but no longer freshly recalled.
    appendTurn("t2", "unrelated follow-up");
    const laterBox = readAccordionView(scope).boxes.find((b) => b.id === "recalled");
    expect(laterBox?.state).toBe("live");
    expect(laterBox?.recalled).toBe(false);
  });
});
