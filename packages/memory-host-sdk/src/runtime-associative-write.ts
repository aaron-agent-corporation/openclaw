// Associative WRITE surface: the dreaming enrichment pass persists box importance,
// rollups, summary_embedding_ref, DAG parent edges, tag/entity associations, and box
// auto-expand. Every write crosses the plugin->core boundary and is validated by core;
// the read-only `runtime-associative.ts` sibling stays write-free.
export {
  associateEnrichmentEntity,
  associateEnrichmentTag,
  autoExpandBox,
  linkTagParent,
  listEnrichmentTagEdges,
  upsertEnrichmentEntity,
  upsertEnrichmentTag,
  writeBoxEnrichment,
  type BoxEnrichment,
  type MemoryTagEdgeRow,
  applyRetrievalAutoExpand,
  resolveRetrievalAutoExpand,
  ACCORDION_STRONG_MATCH_CUTOFF,
  type RetrievalAutoExpandDecision,
  type RetrievalAutoExpandLog,
} from "./host/openclaw-runtime.js";
