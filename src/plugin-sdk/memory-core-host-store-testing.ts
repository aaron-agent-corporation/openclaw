/**
 * Private local-only durable-store seeding helpers for first-party memory tests.
 *
 * The dreaming enrichment pass only reads boxes and writes enrichment; there is no public
 * turn/span/box capture seam (capture lives on the core hot path). First-party plugin tests
 * that exercise enrichment need to seed a realistic turns/spans/boxes store, so this narrow
 * testing subpath exposes the append/upsert primitives.
 *
 * PRIVATE / local-only: registered in plugin-sdk-private-local-only-subpaths.json, so it is
 * built for in-repo test resolution (tsconfig path mapping) but NOT advertised in package.json
 * exports and NOT shipped in the published tarball — an installed plugin never sees this subpath.
 * Keeping it public would advertise a subpath that does not resolve when installed (finding #8).
 */
export {
  appendTurns,
  listBoxes,
  upsertBox,
  upsertSpan,
  type NewTurn,
} from "../agents/memory/turns-store.js";
