/**
 * Private local-only durable-store seeding helpers for first-party memory tests.
 *
 * The dreaming enrichment pass only reads boxes and writes enrichment; there is no public
 * turn/span/box capture seam (capture lives on the core hot path). First-party plugin tests
 * that exercise enrichment need to seed a realistic turns/spans/boxes store, so this narrow
 * testing subpath exposes the append/upsert primitives. Not part of the plugin runtime
 * contract — tests only.
 */
export {
  appendTurns,
  listBoxes,
  upsertBox,
  upsertSpan,
  type NewTurn,
} from "../agents/memory/turns-store.js";
