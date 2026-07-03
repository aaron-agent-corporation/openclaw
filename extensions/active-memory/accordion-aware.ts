/**
 * Accordion-aware query mode (Phase 5, 05-04 / RETR-01; spec §6.4/§6.6/§9). The additive 4th
 * `queryMode` value on active-memory. In this mode, before the main model turn, active-memory
 * runs the conservative strong-match retrieval auto-expand: it reads the associative context and
 * asks the core write seam to auto-expand the best-matching COLLAPSED box when (and only when)
 * the match is strong. On a strong match the box is flipped to live (the current turn renders it
 * verbatim — no one-turn lag) and the write path durably stamps recalled_at_seq (drives the
 * recalled marker); every decision is logged with its score (§13).
 *
 * NO SILENT FALLBACK (§9): if the accordion-aware evaluation finds nothing strong, the mode does
 * NOT re-run a weaker `message`/`recent` retrieval to force an injection — it simply reports no
 * expansion. The seams are injected so the escalation logic is unit-testable without a store.
 */
import type { AssociativeContext } from "openclaw/plugin-sdk/memory-core-host-associative";
import type { RetrievalAutoExpandLog } from "openclaw/plugin-sdk/memory-core-host-associative-write";

/** The additive 4th queryMode value. */
export const ACCORDION_AWARE_QUERY_MODE = "accordion-aware" as const;

export type AccordionAwareQueryMode = typeof ACCORDION_AWARE_QUERY_MODE;

/** Narrow a raw queryMode string to the accordion-aware value. */
export function isAccordionAwareQueryMode(value: unknown): value is AccordionAwareQueryMode {
  return value === ACCORDION_AWARE_QUERY_MODE;
}

/** Injected core seams (real ones come from the associative read/write SDK subpaths). */
export type AccordionAwareSeams = {
  readAssociativeContext: (scope: { agentId: string; sessionKey: string }) => AssociativeContext;
  applyRetrievalAutoExpand: (params: {
    agentId: string;
    sessionKey: string;
    query: string;
    context: AssociativeContext;
  }) => { decision: RetrievalAutoExpandLog; log: RetrievalAutoExpandLog };
  logDecision: (log: RetrievalAutoExpandLog) => void;
};

export type AccordionAwareAutoExpandResult = {
  expanded: boolean;
  expandedBoxIds: string[];
  score: number;
  /** Always false — the mode never degrades to a weaker query (no silent fallback, §9). */
  fellBackToWeakerMode: false;
};

/**
 * Run the accordion-aware auto-expand for one turn: read the associative context, run the single
 * strong-match decision, log it, and report which boxes were expanded. Never falls back to a
 * weaker retrieval mode.
 */
export function runAccordionAwareAutoExpand(
  params: { agentId: string; sessionKey: string; query: string } & AccordionAwareSeams,
): AccordionAwareAutoExpandResult {
  const scope = { agentId: params.agentId, sessionKey: params.sessionKey };
  const context = params.readAssociativeContext(scope);
  const { log } = params.applyRetrievalAutoExpand({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    query: params.query,
    context,
  });
  params.logDecision(log);
  // The expanded box id comes straight from the decision the write seam already returned — no
  // separate render-state lookup (the durable recalled_at_seq stamp drives the marker instead).
  const expandedBoxIds = log.expanded && log.boxId != null ? [log.boxId] : [];
  return {
    expanded: log.expanded,
    expandedBoxIds,
    score: log.score,
    fellBackToWeakerMode: false,
  };
}
