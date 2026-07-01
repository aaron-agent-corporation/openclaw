/**
 * Accordion UI projection (Phase 2, 02-03-5): the read side that surfaces the durable
 * topic boxes (and their span seq-ranges) to the Control UI through chat.startup /
 * chat.history. The UI renders a per-topic collapse/expand control from `boxes` and
 * round-trips a toggle through the `accordion.toggle` gateway method. `spans` carry the
 * box → seq-range mapping for a later inline-fold consumer; both are read-only views of
 * the canonical store — the UI never mutates turns, only flips state via the gateway.
 */
import { injectedThisTurnBoxIds } from "./accordion-auto-expand.js";
import { listBoxes, listSpans } from "./turns-store.js";

export type AccordionBoxView = {
  id: string;
  label: string | null;
  state: "live" | "collapsed";
  summary: string | null;
  /**
   * True when this box was auto-expanded back into context by an accordion-aware retrieval match
   * THIS turn (05-04 / D-02). Drives the visible `recalled: {topic}` marker so the owner sees why
   * an old topic reappeared — distinct from a manual expand or an already-live box.
   */
  recalled: boolean;
};

/**
 * The user-facing `recalled: {topic}` marker text for an auto-expanded box (D-02). One shared
 * builder so the transcript render (accordion-extension) and the web UI (topic-accordion) surface
 * identical wording. Falls back to a generic label when the box has no topic/summary label.
 */
export function recalledMarkerText(label: string | null | undefined): string {
  const topic = label?.trim();
  return `recalled: ${topic && topic.length > 0 ? topic : "earlier topic"}`;
}

export type AccordionSpanView = {
  boxId: string | null;
  startSeq: number;
  endSeq: number;
  topic: string | null;
};

export type AccordionView = {
  boxes: AccordionBoxView[];
  spans: AccordionSpanView[];
};

/** Project the per-agent store's boxes/spans into the UI-facing accordion shape. */
export function readAccordionView(scope: { agentId: string; sessionKey: string }): AccordionView {
  const recalledBoxIds = new Set(injectedThisTurnBoxIds(scope));
  const boxes = listBoxes(scope).map((box) => ({
    id: box.box_id,
    label: box.label,
    state: box.state === "collapsed" ? ("collapsed" as const) : ("live" as const),
    summary: box.summary,
    recalled: recalledBoxIds.has(box.box_id),
  }));
  const spans = listSpans(scope).map((span) => ({
    boxId: span.box_id,
    startSeq: span.start_seq,
    endSeq: span.end_seq,
    topic: span.topic,
  }));
  return { boxes, spans };
}
