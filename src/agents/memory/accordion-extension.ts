/**
 * Accordion context extension (Phase 2, 02-02): the core "context" hook that folds
 * collapsed-topic turns out of the model's context. Registered by
 * buildEmbeddedExtensionFactories when conversationalMemory is enabled. Reads the
 * per-agent store fresh each context event (the box state is canonical and changes as
 * topics collapse/expand — this is live state, not freshness polling of static metadata).
 *
 * Mapping: each live message → its durable per-message anchor → captured turn (seq) →
 * span → box. Collapsed boxes drive the fold plan (accordion-seq-walk), applied in place
 * (accordion-blocks.applyFold). Returns undefined (passthrough) when nothing is collapsed.
 */
import type { AgentMessage } from "../runtime/index.js";
import type { ContextEvent, ExtensionAPI, ExtensionFactory } from "../sessions/index.js";
import { applyFold, messageAnchorId } from "./accordion-blocks.js";
import { type AnchorBox, buildAccordionFoldPlan } from "./accordion-seq-walk.js";
import { recalledMarkerText } from "./accordion-ui.js";
import { applyAutoCollapse } from "./active-tag-set.js";
import { turnIdempotencyKey } from "./turns-capture.js";
import {
  getTurns,
  listBoxes,
  type BoxRow,
  listSpans,
  readHeadSeq,
  type SpanRow,
} from "./turns-store.js";

/**
 * Build the verbatim `recalled: {topic}` marker messages (D-02) for boxes auto-expanded by an
 * accordion-aware retrieval match THIS turn. The box is already live (rendered verbatim), so the
 * marker is a lightweight leading note that tells the owner/model why an old topic reappeared —
 * the same mental model as the manual expand/collapse control. A box qualifies iff it is live AND
 * its retrieval auto-expand stamped the current head seq (boxes.recalled_at_seq === head): the
 * signal self-clears once the head advances, so a still-live box never re-emits the marker on a
 * later turn. Manually-expanded or already-live boxes carry a stale/absent stamp and get no marker.
 */
function buildRecalledMarkers(boxes: readonly BoxRow[], headSeq: number | null): AgentMessage[] {
  if (headSeq == null) {
    return [];
  }
  const markers: AgentMessage[] = [];
  for (const box of boxes) {
    if (box.state === "collapsed" || box.recalled_at_seq !== headSeq) {
      continue;
    }
    markers.push({
      role: "user",
      content: [{ type: "text", text: recalledMarkerText(box.label ?? box.summary) }],
    } as AgentMessage);
  }
  return markers;
}

/**
 * Prebuilt seq -> owning box id lookup over a session's spans. Spans are contiguous,
 * non-overlapping seq ranges owned by at most one box, so sorting once by start_seq lets each
 * message resolve its box by binary search — O(log spans) instead of a linear spans.find() inside
 * the per-message loop (O(messages × spans) on the hot context path).
 */
function buildSeqToBoxId(spans: readonly SpanRow[]): (seq: number) => string | null {
  const sorted = [...spans].sort((a, b) => a.start_seq - b.start_seq);
  return (seq: number): string | null => {
    let lo = 0;
    let hi = sorted.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const span = sorted[mid];
      if (seq < span.start_seq) {
        hi = mid - 1;
      } else if (seq > span.end_seq) {
        lo = mid + 1;
      } else {
        return span.box_id;
      }
    }
    return null;
  };
}

/**
 * Resolve each live message's collapsed/live box from the shared per-turn boxes snapshot. Returns
 * null (skip everything) when no box is collapsed, so the common case avoids the heavier turn/span
 * reads.
 */
function resolveAnchorBoxes(
  agentId: string,
  sessionKey: string,
  boxes: readonly BoxRow[],
  messages: readonly AgentMessage[],
): Map<string, AnchorBox> | null {
  if (!boxes.some((box) => box.state === "collapsed")) {
    return null;
  }
  const boxById = new Map(boxes.map((box) => [box.box_id, box]));
  const seqToBoxId = buildSeqToBoxId(listSpans({ agentId, sessionKey }));
  const keyToSeq = new Map(
    getTurns({ agentId, sessionKey }).map((turn) => [turn.idempotency_key, turn.seq]),
  );

  const anchorToBox = new Map<string, AnchorBox>();
  for (const message of messages) {
    const key = turnIdempotencyKey(sessionKey, message);
    if (key == null) {
      continue;
    }
    const seq = keyToSeq.get(key);
    if (seq == null) {
      continue;
    }
    const boxId = seqToBoxId(seq);
    if (boxId == null) {
      continue;
    }
    const box = boxById.get(boxId);
    const anchor = messageAnchorId(message);
    if (box == null || anchor == null) {
      continue;
    }
    anchorToBox.set(anchor, {
      boxId: box.box_id,
      state: box.state === "collapsed" ? "collapsed" : "live",
      summary: box.summary,
    });
  }
  return anchorToBox;
}

export function conversationalMemoryAccordionExtension(opts: {
  agentId: string;
  sessionKey: string;
}): ExtensionFactory {
  return (api: ExtensionAPI) => {
    api.on("context", (event: ContextEvent) => {
      let anchorToBox: Map<string, AnchorBox> | null;
      let recalledMarkers: AgentMessage[];
      try {
        // Run the active-tag-set rule first (spec §16: collapse decision in the
        // context-pruning seam) so any newly-stale topic is folded out this turn.
        applyAutoCollapse({ agentId: opts.agentId, sessionKey: opts.sessionKey });
        // Read the post-collapse boxes ONCE per turn and share the snapshot across the recalled
        // marker and anchor resolution — the box state is now settled for this turn, so re-reading
        // it would only add redundant hot-path queries.
        const boxes = listBoxes({ agentId: opts.agentId, sessionKey: opts.sessionKey });
        // A retrieval-auto-expanded box (05-04) is now live and rendered verbatim; surface a
        // `recalled: {topic}` marker (D-02) so the owner sees why the old topic reappeared. This
        // is independent of the fold plan — a recalled box is not collapsed.
        recalledMarkers = buildRecalledMarkers(
          boxes,
          readHeadSeq({ agentId: opts.agentId, sessionKey: opts.sessionKey }),
        );
        anchorToBox = resolveAnchorBoxes(opts.agentId, opts.sessionKey, boxes, event.messages);
      } catch (err) {
        // Never break a model call over the accordion; fall through to verbatim context.
        console.warn(
          `[conversational-memory] accordion fold skipped: ${err instanceof Error ? err.message : String(err)}`,
        );
        return undefined;
      }
      const plan = anchorToBox == null ? null : buildAccordionFoldPlan(event.messages, anchorToBox);
      const folded = plan && plan.size > 0 ? applyFold(event.messages, plan) : event.messages;
      if (recalledMarkers.length === 0 && folded === event.messages) {
        return undefined;
      }
      return { messages: [...recalledMarkers, ...folded] };
    });
  };
}
