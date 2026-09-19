// Config + data dirs. One file, ~/.openmausbot/config.json, env fallbacks:
//   { "xai": {"key":"xai-…"}, "composio": {"apiKey":"ak_…"}, "box": {"token":"…"},
//     "instances": { "<instanceId>": {"driver":"grok", …} } }

// Public import surface. The implementation lives in focused modules under
// ./config/; every name the original single file exported is re-exported
// below, so existing "./config.ts" imports keep working unchanged.
export {
  DEFAULT_LOCAL_VM_MAX_INSTANCES,
  DEFAULT_LOCAL_VM_MODE,
  DEFAULT_MAX_CONCURRENT_BOT_THREADS,
  DEFAULT_ROOM_TURN_TIMEOUT_MINUTES,
  MAX_CONCURRENT_BOT_THREADS,
  MAX_LOCAL_VM_MAX_INSTANCES,
  MAX_ROOM_TURN_TIMEOUT_MINUTES,
  MAX_THREAD_EVENT_LOG_BYTES,
  MIN_LOCAL_VM_MAX_INSTANCES,
  MIN_ROOM_TURN_TIMEOUT_MINUTES,
  MIN_THREAD_EVENT_LOG_BYTES,
  DEFAULT_ROOM_HANDOFF_HARD_CAP_MINUTES,
  DEFAULT_ROOM_HANDOFF_LIFETIME_MINUTES,
  DEFAULT_ROOM_HANDOFF_MIN_RUNWAY_MINUTES,
  isValidCdpTarget,
  isValidSshAlias,
  parseConfigPatch,
  parseStoredConfig,
} from "./config/schema.ts";
export type { AppConfig, BrowserProfile, ConfigPatch } from "./config/schema.ts";
export {
  FLEET_NEUTRAL_KEYS,
  browserEngineAttachCdpUrl,
  builtInBrowserEnabled,
  claudeUserMcpEnabled,
  llmThreadTitlesEnabled,
  localVmMaxInstances,
  localVmMode,
  maxConcurrentBotThreads,
  normalizeVpsConfig,
  providerReloadKeys,
  roomHandoffLimits,
  roomTurnTimeoutMinutes,
  sharedComputersEnabled,
  showToolCallsEnabled,
  skillAuthoringEnabled,
  threadEventLogMaxBytes,
  threadEventLogRetentionDays,
  vpsSshAlias,
} from "./config/accessors.ts";
export {
  browserProfilePartitionId,
  browserProfilePartitionTarget,
  browserProfileReplacementConflict,
  browserProfileRoutingConflict,
} from "./config/profiles.ts";
export type { BrowserProfilePartitionTarget } from "./config/profiles.ts";
export {
  DATA_DIR,
  EVENTS_DIR,
  NATIVE_DIR,
  ensureDirs,
  loadBrowserProfileIdAliases,
  loadConfig,
  saveConfig,
} from "./config/io.ts";
export {
  PROVIDER_CREDENTIAL_ENV,
  WORKSPACE_CREDENTIAL_ENV,
  stripWorkspaceCredentialEnv,
  syncCredentialEnv,
} from "./config/credentials.ts";
export {
  instanceConfigs,
  persistableInstanceConfigs,
  withInstanceCli,
} from "./config/instance-cli.ts";
export { customMcpServers } from "./config/mcp.ts";
export type { CustomMcpServer } from "./config/mcp.ts";
export type { RoomHandoffLimitsMs } from "./config/accessors.ts";
