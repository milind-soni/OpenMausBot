// The MCP servers a pi turn mounts, each gated by the turn's tool scope like every other engine's.
import { canUseMcpServer, parseToolScope } from "../../shared/tool-scope.ts";
import { OWN_APPS_SERVER } from "../../shared/own-apps.ts";
import type { SendTurnInput } from "../contracts.ts";
import { appMountFor, customServerGate, gateServer, mcpStdioServer } from "../mcp-gate-config.ts";
import { remoteMcpSpec } from "../mcp-http.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";

const NODE_ENV_FLAG = { ELECTRON_RUN_AS_NODE: "1" };

export function buildMcpServers(turn: SendTurnInput): Record<string, unknown> | null {
  const parsed = parseToolScope(turn.toolScope);
  if (!parsed.ok) throw new Error(parsed.error);
  const servers: Record<string, unknown> = {};
  if (turn.integrations?.composio) servers.composio = { ...turn.integrations.composio }; if (turn.integrations?.composioOwn) servers[OWN_APPS_SERVER] = { ...turn.integrations.composioOwn };
  if (turn.integrations?.localComputer) {
    const local = turn.integrations.localComputer;
    servers.computer = {
      command: local.command,
      args: local.args,
      env: local.env,
      // Host control carries scope so the extension gates every call behind a permission card.
      ...(local.scope ? { scope: local.scope } : {}),
    };
  }
  if (turn.integrations?.agents) servers.agents = { ...turn.integrations.agents };
  if (turn.integrations?.phone) servers.phone = { ...turn.integrations.phone };
  if (turn.integrations?.dweb) {
    servers.dweb = {
      command: process.execPath,
      args: [SPAWNED_PROXIES.dweb],
      env: { ...NODE_ENV_FLAG, DWEB_URL: turn.integrations.dweb.url },
    };
  }
  if (turn.integrations?.browser) servers.browser = { ...turn.integrations.browser };
  for (const name of ["data", "email", "device", "edu"] as const) if (turn.integrations?.[name]) servers[name] = { ...turn.integrations[name] };
  const custom = Object.entries(turn.integrations?.custom ?? {}).filter(([name]) => !Object.hasOwn(servers, name));
  for (const [name, server] of custom) servers[name] = { ...server, scope: "custom" };
  const customNames = new Set(custom.map(([name]) => name));
  for (const [name, server] of Object.entries(servers)) {
    if (parsed.scope !== undefined && !canUseMcpServer(parsed.scope, name)) { delete servers[name]; continue; }
    // pi registers every tool it is given and has no tool search of its own.
    const directory = remoteMcpSpec(server) !== undefined;
    const gated = gateServer({ name, server, toolScope: parsed.scope, threadId: turn.threadId, nodeEnv: NODE_ENV_FLAG, directory, ...customServerGate(name, customNames.has(name), turn.integrations?.customResultBudgets), apps: appMountFor(name, turn) });
    const stdio = gated ?? mcpStdioServer(server, { nodeEnv: NODE_ENV_FLAG, ...(directory ? { directory: { name } } : {}) });
    if (!stdio) throw new Error("Pi MCP server configuration is invalid");
    const original = server as { scope?: string };
    servers[name] = { ...stdio, ...(original.scope ? { scope: original.scope } : {}), ...(directory ? { directory: true } : {}) };
  }
  return Object.keys(servers).length ? servers : null;
}
