// Agent/runtime helpers.
export { resolveCronStyleNow } from "../../../../src/agents/current-time.js";
export {
  resolveAgentContextLimits,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
  resolveSessionAgentId,
} from "../../../../src/agents/agent-scope.js";
export { requireApiKey, resolveApiKeyForProvider } from "../../../../src/agents/model-auth.js";
export { stripInternalRuntimeContext } from "../../../../src/agents/internal-runtime-context.js";
export { DEFAULT_AGENT_COMPACTION_RESERVE_TOKENS_FLOOR } from "../../../../src/agents/agent-settings.js";
export {
  asToolParamsRecord,
  jsonResult,
  readNumberParam,
  readStringParam,
} from "../../../../src/agents/tools/common.js";
export type { AnyAgentTool } from "../../../../src/agents/tools/common.js";
export {
  resolveMemorySearchConfig,
  resolveMemorySearchSyncConfig,
  type ResolvedMemorySearchConfig,
  type ResolvedMemorySearchSyncConfig,
} from "../../../../src/agents/memory-search.js";

// Read-only associative context (topic boxes + linked tags/entities) for search ranking.
export {
  readAssociativeContext,
  readBoxRollupInputs,
  type AssociativeBoxContext,
  type AssociativeContext,
  type BoxRollupInputs,
} from "../../../../src/agents/memory/associative-context.js";
// §7 importance scorer + the single tunable enrichment-cap surface (TUNE-02). Exposed on the
// read seam so the memory-core dreaming pass scores and bounds itself without importing core.
export {
  computeImportance,
  type ImportanceInputs,
  type ImportanceResult,
} from "../../../../src/agents/memory/importance-score.js";
export {
  ENRICHMENT_LOW_SALIENCE_FLOOR,
  ENRICHMENT_MAX_BOXES_PER_NIGHT,
  ENRICHMENT_MAX_TAG_EDGES_PER_NIGHT,
  ENRICHMENT_MIN_COOCCURRENCE_WEIGHT,
  ENRICHMENT_ROLLUP_MAX_CHARS,
  ENRICHMENT_ROLLUP_MAX_TURNS,
} from "../../../../src/agents/memory/accordion-constants.js";
export {
  readTagCooccurrence,
  type TagGraphNeighbor,
  type TagGraphTargetRef,
  type TagGraphTraversal,
} from "../../../../src/agents/memory/tag-graph.js";

// Associative WRITE surface (05-01): the dreaming enrichment pass persists box
// importance / rollups / summary_embedding_ref / DAG edges / associations / auto-expand.
// These writes cross the plugin->core boundary; core validates every one and keeps
// sole ownership of the turns/boxes/associative schema.
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
} from "../../../../src/agents/memory/associative-enrichment-writes.js";
export type { MemoryTagEdgeRow } from "../../../../src/agents/memory/associative-store.js";

// Accordion-aware retrieval auto-expand (05-04 / RETR-01): the accordion-aware query mode runs
// the strong-match decision and, on a strong match, flips a collapsed box to live via the write
// path above so the current turn renders it verbatim. The injected-this-turn registry drives the
// recalled marker. Conservative, recall-safety-first, decision-logged — no silent fallback.
export {
  applyRetrievalAutoExpand,
  resolveRetrievalAutoExpand,
  type RetrievalAutoExpandDecision,
  type RetrievalAutoExpandLog,
} from "../../../../src/agents/memory/accordion-auto-expand.js";
export { ACCORDION_STRONG_MATCH_CUTOFF } from "../../../../src/agents/memory/accordion-constants.js";

// Session and reply helpers.
export { isHeartbeatUserMessage } from "../../../../src/auto-reply/heartbeat-filter.js";
export { HEARTBEAT_PROMPT } from "../../../../src/auto-reply/heartbeat.js";
export { stripInboundMetadata } from "../../../../src/auto-reply/reply/strip-inbound-meta.js";
export {
  HEARTBEAT_TOKEN,
  SILENT_REPLY_TOKEN,
  isSilentReplyPayloadText,
} from "../../../../src/auto-reply/tokens.js";

// CLI/runtime/config helpers.
export { formatErrorMessage, withManager } from "../../../../src/cli/cli-utils.js";
export { resolveCommandSecretRefsViaGateway } from "../../../../src/cli/command-secret-gateway.js";
export { formatHelpExamples } from "../../../../src/cli/help-format.js";
export { parseDurationMs } from "../../../../src/cli/parse-duration.js";
export { withProgress, withProgressTotals } from "../../../../src/cli/progress.js";
export { parseNonNegativeByteSize } from "../../../../src/config/byte-size.js";
export {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
  /** @deprecated Use getRuntimeConfig(), or pass the already loaded config through the call path. */
  loadConfig,
} from "../../../../src/config/config.js";
export type { OpenClawConfig } from "../../../../src/config/config.js";
export { resolveStateDir } from "../../../../src/config/paths.js";
export {
  isCompactionCheckpointTranscriptFileName,
  isSessionArchiveArtifactName,
  isUsageCountedSessionTranscriptFileName,
  parseUsageCountedSessionIdFromFileName,
} from "../../../../src/config/sessions/artifacts.js";
export { canonicalizeMainSessionAlias } from "../../../../src/config/sessions/main-session.js";
export { resolveSessionTranscriptsDirForAgent } from "../../../../src/config/sessions/paths.js";
export {
  listSessionEntries,
  resolveSessionFilePath,
  resolveStorePath,
} from "../../../../src/plugin-sdk/session-store-runtime.js";
export type { SessionEntry } from "../../../../src/config/sessions/types.js";
export type { SessionSendPolicyConfig } from "../../../../src/config/types.base.js";
export type {
  MemoryBackend,
  MemoryCitationsMode,
  MemoryQmdConfig,
  MemoryQmdIndexPath,
  MemoryQmdMcporterConfig,
  MemoryQmdSearchMode,
} from "../../../../src/config/types.memory.js";
export {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
} from "../../../../src/config/types.secrets.js";
export type { SecretInput } from "../../../../src/config/types.secrets.js";
export type { MemorySearchConfig } from "../../../../src/config/types.tools.js";
export { isVerbose, setVerbose } from "../../../../src/globals.js";

// IO, network, and logging helpers.
export { isExecCompletionEvent } from "../../../../src/infra/heartbeat-events-filter.js";
export { root } from "../../../../src/infra/fs-safe.js";
export { fetchWithSsrFGuard } from "../../../../src/infra/net/fetch-guard.js";
export { shouldUseEnvHttpProxyForUrl } from "../../../../src/infra/net/proxy-env.js";
export { ssrfPolicyFromHttpBaseUrlAllowedHostname } from "../../../../src/infra/net/ssrf.js";
export {
  DEFAULT_SQLITE_WAL_AUTOCHECKPOINT_PAGES,
  DEFAULT_SQLITE_WAL_CHECKPOINT_INTERVAL_MS,
  DEFAULT_SQLITE_WAL_TRUNCATE_INTERVAL_MS,
  configureSqliteConnectionPragmas,
  configureSqliteWalMaintenance,
} from "../../../../src/infra/sqlite-wal.js";
export type {
  SqliteConnectionPragmaOptions,
  SqliteWalMaintenance,
  SqliteWalMaintenanceOptions,
} from "../../../../src/infra/sqlite-wal.js";
export {
  installProcessWarningFilter,
  shouldIgnoreWarning,
} from "../../../../src/infra/warning-filter.js";
export type { ProcessWarning } from "../../../../src/infra/warning-filter.js";
export { redactSensitiveText } from "../../../../src/logging/redact.js";
export { createSubsystemLogger } from "../../../../src/logging/subsystem.js";
export { detectMime } from "@openclaw/media-core/mime";

// Memory plugin helpers.
export {
  resolveCanonicalRootMemoryFile,
  shouldSkipRootMemoryAuxiliaryPath,
} from "../../../../src/memory/root-memory-files.js";
export {
  getMemoryEmbeddingProvider,
  listMemoryEmbeddingProviders,
  listRegisteredMemoryEmbeddingProviderAdapters,
  listRegisteredMemoryEmbeddingProviders,
} from "../../../../src/plugins/memory-embedding-provider-runtime.js";
export type {
  MemoryEmbeddingBatchChunk,
  MemoryEmbeddingBatchOptions,
  MemoryEmbeddingProvider,
  MemoryEmbeddingProviderAdapter,
  MemoryEmbeddingProviderCallOptions,
  MemoryEmbeddingProviderCreateOptions,
  MemoryEmbeddingProviderCreateResult,
  MemoryEmbeddingProviderRuntime,
} from "../../../../src/plugins/memory-embedding-providers.js";
export { emptyPluginConfigSchema } from "../../../../src/plugins/config-schema.js";
export {
  buildMemoryPromptSection as buildActiveMemoryPromptSection,
  getMemoryCapabilityRegistration,
  listActiveMemoryPublicArtifacts,
} from "../../../../src/plugins/memory-state.js";
export type {
  MemoryFlushPlan,
  MemoryFlushPlanResolver,
  MemoryPluginCapability,
  MemoryPluginPublicArtifact,
  MemoryPluginPublicArtifactsProvider,
  MemoryPluginRuntime,
  MemoryPromptSectionBuilder,
} from "../../../../src/plugins/memory-state.js";
export type { OpenClawPluginApi } from "../../../../src/plugins/types.js";

// Shared session/text utilities.
export { defaultRuntime } from "../../../../src/runtime.js";
export { parseAgentSessionKey } from "../../../../src/routing/session-key.js";
export { hasInterSessionUserProvenance } from "../../../../src/sessions/input-provenance.js";
export { isCronRunSessionKey } from "../../../../src/sessions/session-key-utils.js";
export { onSessionTranscriptUpdate } from "../../../../src/sessions/transcript-events.js";
export { formatDocsLink } from "../../../terminal-core/src/links.js";
export { colorize, isRich, theme } from "../../../terminal-core/src/theme.js";
export { CHARS_PER_TOKEN_ESTIMATE, estimateStringChars } from "../../../../src/utils/cjk-chars.js";
export { runTasksWithConcurrency } from "../../../../src/utils/run-with-concurrency.js";
export { splitShellArgs } from "../../../../src/utils/shell-argv.js";
export {
  resolveUserPath,
  shortenHomeInString,
  shortenHomePath,
  truncateUtf16Safe,
} from "../../../../src/utils.js";
export {
  applyWindowsSpawnProgramPolicy,
  materializeWindowsSpawnProgram,
  resolveWindowsExecutablePath,
  resolveWindowsSpawnProgram,
  resolveWindowsSpawnProgramCandidate,
} from "../../../../src/plugin-sdk/windows-spawn.js";
export type {
  ResolveWindowsSpawnProgramCandidateParams,
  ResolveWindowsSpawnProgramParams,
  WindowsSpawnCandidateResolution,
  WindowsSpawnInvocation,
  WindowsSpawnProgram,
  WindowsSpawnProgramCandidate,
  WindowsSpawnResolution,
} from "../../../../src/plugin-sdk/windows-spawn.js";
export { resolveGlobalSingleton } from "../../../../src/shared/global-singleton.js";
