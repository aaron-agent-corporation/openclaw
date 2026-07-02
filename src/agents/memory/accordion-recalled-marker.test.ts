// 05-04 Task 3: the visible `recalled: {topic}` marker (D-02). A box auto-expanded by an
// accordion-aware retrieval match this turn gets a marker in the transcript projection; a
// manually-expanded or already-live box does not. The marker text names the topic.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { clearInjectedThisTurn, resolveRetrievalAutoExpand } from "./accordion-auto-expand.js";
import { readAccordionView, recalledMarkerText } from "./accordion-ui.js";
import { upsertBox } from "./turns-store.js";

const AGENT = "main";
const SESSION_KEY = "agent:main:main";
const scope = { agentId: AGENT, sessionKey: SESSION_KEY };
let priorStateDir: string | undefined;

beforeEach(() => {
  priorStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-recalled-"));
  clearInjectedThisTurn(scope);
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  clearInjectedThisTurn(scope);
  if (priorStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = priorStateDir;
  }
});

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
    upsertBox({
      agentId: AGENT,
      box: { boxId: "recalled", sessionKey: SESSION_KEY, label: "Fidel case", state: "collapsed" },
    });
    upsertBox({
      agentId: AGENT,
      box: { boxId: "plain", sessionKey: SESSION_KEY, label: "Voice", state: "live" },
    });
    // A strong match marks "recalled" injectedThisTurn (pure decision; no DB flip needed here).
    const decision = resolveRetrievalAutoExpand({
      ...scope,
      query: "the Fidel case",
      context: {
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
      },
    });
    expect(decision.expanded).toBe(true);

    const view = readAccordionView(scope);
    const recalled = view.boxes.find((b) => b.id === "recalled");
    const plain = view.boxes.find((b) => b.id === "plain");
    expect(recalled?.recalled).toBe(true);
    expect(plain?.recalled).toBe(false);
  });
});
