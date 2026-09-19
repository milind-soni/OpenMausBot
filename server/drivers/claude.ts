// Claude driver — public import surface. The implementation lives in focused
// modules under ./claude/; every name the original single file exported is
// re-exported below, so existing `.../drivers/claude.ts` imports — including
// `import { ClaudeDriver } from "./claude.ts"` — keep working unchanged.
// See ./claude/driver.ts for the driver itself.
export {
  claudeSignedIn,
  CLAUDE_ACCOUNT_ENV_KEYS,
  resolveClaudeConfigDir,
  claudeAuthFailure,
  claudeInheritWarning,
  readClaudeAuthSettings,
  autoCompactWindow,
} from "./claude/env-auth.ts";
export {
  CLAUDE_FLAG_FLOORS,
  CLAUDE_CONTEXT_CONTROL_MIN_VERSION,
  parseClaudeCliVersion,
  claudeCliSupports,
  claudeCliUpdate,
} from "./claude/cli-version.ts";
export type { ClaudeCliVersion } from "./claude/cli-version.ts";
export { ClaudeDriver } from "./claude/driver.ts";
export { STATIC_CLAUDE_MODELS, readClaudeModelCatalog } from "./claude/models.ts";
export type { ClaudeConfig } from "./claude/models.ts";
export {
  permissionSocketPath,
  brokerSocketCandidates,
  createPermissionBroker,
} from "./claude/permission-broker.ts";
