// App-server launch prerequisites and argv for a codex turn: the Company
// (managed) turn gate, the reserved-MCP-env check, then the "app-server"
// base command, provider routing, and every per-turn MCP mount (built-ins,
// user-configured servers, the phone bridge). Pure/explicit like acp/wire.ts;
// env is mutated in place because credentials ride the child environment,
// never argv, and the spawn lifecycle stays in the driver.
import type { SendTurnInput } from "../../contracts.ts";
import { isHarnessOwnedMcpEnvName } from "../../mcp-registry.ts";
import { codexLocalProviderArgs } from "../local-inject.ts";
import { type CodexConfig, managedCodexArgs } from "./config.ts";
import { mountMcpServer, noteSkippedSseServer } from "./mcp.ts";

export function assertCompanyTurnAllowed(
  config: CodexConfig,
  turn: SendTurnInput,
  environment: Record<string, string>,
): void {
  if (config.managed) {
    // One blanket refusal hides which prerequisite broke; name it so the
    // person can fix the actual gap instead of reconnecting blind.
    if (!turn.model) {
      throw new Error("Company model access is unavailable: no model is selected. Reconnect your organization; personal billing will not be used.");
    }
    if (!config.managed.models.includes(turn.model)) {
      throw new Error("Company model access is unavailable: " + turn.model + " is not approved for your organization. Reconnect your organization; personal billing will not be used.");
    }
    if (!environment.OPENMAUSBOT_COMPANY_API_KEY) {
      throw new Error("Company model access is unavailable: OPENMAUSBOT_COMPANY_API_KEY is missing. Reconnect your organization; personal billing will not be used.");
    }
    if (!environment.CODEX_HOME) {
      throw new Error("Company model access is unavailable: CODEX_HOME is missing. Reconnect your organization; personal billing will not be used.");
    }
  }
}

export function assertNoReservedMcpEnv(turn: SendTurnInput): void {
  for (const [name, server] of Object.entries(turn.integrations?.custom ?? {})) {
    if ("url" in server) continue;
    const reserved = Object.keys(server.env).find(isHarnessOwnedMcpEnvName);
    if (reserved) {
      throw new Error(`Custom MCP server “${name}” cannot set reserved environment variable “${reserved}”`);
    }
  }
}

export function codexAppServerArgs(
  config: CodexConfig,
  turn: SendTurnInput,
  env: Record<string, string | undefined>,
): string[] {
  const appServerArgs = ["app-server", ...(config.managed ? managedCodexArgs(config.managed) : codexLocalProviderArgs(env, turn.model))];
  if (turn.integrations?.composio) {
    mountMcpServer(appServerArgs, env, "openmausbot_connectors", turn.integrations.composio);
  }
  if (turn.integrations?.agents) {
    mountMcpServer(appServerArgs, env, "agents", turn.integrations.agents);
  }
  if (turn.integrations?.localComputer) {
    // The host daemon and isolated Local VM both arrive as a direct Cua
    // Driver stdio MCP server. Codex sees the same computer tool surface.
    mountMcpServer(appServerArgs, env, "computer", turn.integrations.localComputer);
  }
  if (turn.integrations?.browser) {
    mountMcpServer(appServerArgs, env, "browser", turn.integrations.browser);
  }
  for (const [name, server] of Object.entries(turn.integrations?.custom ?? {})) {
    // codex speaks streamable HTTP to a remote server, not the older
    // SSE transport: such an entry still reaches Claude bots, and is
    // left out here rather than mounted as something it is not
    if ("url" in server && server.type === "sse") {
      noteSkippedSseServer(name);
      continue;
    }
    mountMcpServer(appServerArgs, env, name, server, false);
  }
  if (turn.integrations?.phone) {
    const bridge = turn.integrations.phone;
    Object.assign(env, bridge.env);
    const prefix = "mcp_servers.openmausbot_phone";
    appServerArgs.push(
      "-c", `${prefix}.command=${JSON.stringify(bridge.command)}`,
      "-c", `${prefix}.args=${JSON.stringify(bridge.args)}`,
      "-c", `${prefix}.env_vars=${JSON.stringify(Object.keys(bridge.env))}`,
      "-c", `${prefix}.default_tools_approval_mode="auto"`,
    );
  }
  return appServerArgs;
}
