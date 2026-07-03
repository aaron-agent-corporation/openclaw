/**
 * Public SDK subpath: the WRITE counterpart to the read-only
 * `memory-core-host-associative` seam. Lets the memory-core dreaming enrichment
 * pass persist box importance / rollups / summary_embedding_ref / DAG parent edges
 * / tag+entity associations / box auto-expand into the per-agent store. Every write
 * is validated by core, which keeps sole ownership of the turns/boxes/associative
 * schema. The read subpath stays read-only.
 */
export * from "../../packages/memory-host-sdk/src/runtime-associative-write.js";
