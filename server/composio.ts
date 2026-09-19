// A project API key (ak_…) creates/reuses one Composio Session. That
// Session owns connection state, auth links and the MCP endpoint.

// Public import surface. The implementation lives in focused modules under
// ./composio/; every name the original single file exported is re-exported
// below, so existing "./composio.ts" imports keep working unchanged.
export type {
  ComposioMcpIntegration,
  ConnectedAccountSummary,
  ConnectorAvailability,
  ConnectorServiceState,
} from "./composio/state.ts";
export {
  applyManagedBrokerMessage,
  connectionMode,
  configured,
  connectorAvailability,
  setManagedBrokerAccess,
} from "./composio/state.ts";
export {
  listCustomAuthConfigs,
  normalizeAccountAlias,
  prepareProjectSession,
} from "./composio/sessions.ts";
export { mcpIntegration, relayMcp } from "./composio/mcp.ts";
export {
  authorizeService,
  connectedServices,
  connectionStatus,
  removeAccount,
  removeService,
} from "./composio/accounts.ts";
export type { ToolkitCard } from "./composio/toolkits.ts";
export { CURATED_SLUGS, listToolkits, toolkitCard } from "./composio/toolkits.ts";
