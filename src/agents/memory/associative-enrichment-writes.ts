/**
 * Phase 5 (05-01) core-owned enrichment WRITE surface. The memory-core dreaming
 * pass reaches these validated writers through the public
 * `openclaw/plugin-sdk/memory-core-host-associative-write` subpath so it can
 * persist importance / rollup summaries / summary_embedding_ref / DAG parent
 * edges / tag+entity associations / box auto-expand into the per-agent store,
 * while core keeps sole ownership of the turns/boxes/associative schema.
 *
 * Every writer composes an existing validated primitive and adds only the
 * enrichment-specific range/blank guards. It adds no tables and no raw SQL.
 */
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db.js";
import {
  associateMemoryEntity,
  associateMemoryTag,
  linkMemoryTagParent,
  upsertMemoryEntity,
  upsertMemoryTag,
  type MemoryAssociationSource,
  type MemoryAssociationTarget,
} from "./associative-store.js";
import { listBoxes, setBoxState, upsertBox } from "./turns-store.js";

function assertNonBlank(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${field} must not be blank`);
  }
  return trimmed;
}

/** Enrichment columns the dreaming deep-pass writes onto an existing box. */
export type BoxEnrichment = {
  boxId: string;
  sessionKey: string;
  importance?: number | null;
  summary?: string | null;
  summaryEmbeddingRef?: string | null;
  suppressionRollup?: string | null;
};

/**
 * Persist importance / rollup summary / summary_embedding_ref / suppression_rollup
 * onto an existing box. Reads the current row first so label/state/last_active_seq
 * are preserved (enrichment never re-labels or re-renders a box), which also makes
 * re-running with identical inputs a no-op. Importance is the normalized §7 score
 * and must stay within [0,1].
 */
export function writeBoxEnrichment(
  options: OpenClawAgentDatabaseOptions & { box: BoxEnrichment },
): void {
  const boxId = assertNonBlank(options.box.boxId, "boxId");
  const sessionKey = assertNonBlank(options.box.sessionKey, "sessionKey");
  const importance = options.box.importance;
  if (importance != null && (!Number.isFinite(importance) || importance < 0 || importance > 1)) {
    throw new Error(`box importance must be within [0,1], received ${String(importance)}`);
  }
  const existing = listBoxes({ ...options, sessionKey }).find((row) => row.box_id === boxId);
  if (existing == null) {
    throw new Error(`Unknown box: ${boxId}`);
  }
  upsertBox({
    ...options,
    box: {
      boxId,
      sessionKey,
      label: existing.label,
      state: existing.state as "collapsed" | "live",
      lastActiveSeq: existing.last_active_seq,
      importance: importance ?? null,
      summary: options.box.summary ?? null,
      summaryEmbeddingRef: options.box.summaryEmbeddingRef ?? null,
      suppressionRollup: options.box.suppressionRollup ?? null,
    },
  });
}

/**
 * Add a DAG parent edge between two existing tags. Delegates to the cycle-guarded
 * primitive so the "would create a tag cycle" invariant is preserved unchanged.
 */
export function linkTagParent(
  options: OpenClawAgentDatabaseOptions & {
    childTagId: string;
    parentTagId: string;
    relation?: string;
  },
): void {
  linkMemoryTagParent(options);
}

/** Upsert a tag the dreaming pass discovered. Thin validated wrapper. */
export function upsertEnrichmentTag(
  options: OpenClawAgentDatabaseOptions & { tag: { label: string; tagId: string } },
): void {
  upsertMemoryTag(options);
}

/** Associate a tag to a durable turn/span/box target. */
export function associateEnrichmentTag(
  options: OpenClawAgentDatabaseOptions & {
    salience?: number | null;
    source: MemoryAssociationSource;
    tagId: string;
    target: MemoryAssociationTarget;
  },
): void {
  associateMemoryTag(options);
}

/** Upsert a first-class local-only entity the dreaming pass extracted. */
export function upsertEnrichmentEntity(
  options: OpenClawAgentDatabaseOptions & {
    entity: { entityId: string; label: string; localOnly?: boolean; type: string };
  },
): void {
  upsertMemoryEntity(options);
}

/** Associate an entity to a durable turn/span/box target. */
export function associateEnrichmentEntity(
  options: OpenClawAgentDatabaseOptions & {
    entityId: string;
    salience?: number | null;
    source: MemoryAssociationSource;
    target: MemoryAssociationTarget;
  },
): void {
  associateMemoryEntity(options);
}

/**
 * Auto-expand a collapsed box on a strong retrieval match (RETR-01 / §6.6): flip
 * boxes.state to "live" so the seq-walk renders it verbatim. The only mutation
 * auto-expand performs.
 */
export function autoExpandBox(options: OpenClawAgentDatabaseOptions & { boxId: string }): void {
  const boxId = assertNonBlank(options.boxId, "boxId");
  setBoxState({ ...options, boxId, state: "live" });
}
