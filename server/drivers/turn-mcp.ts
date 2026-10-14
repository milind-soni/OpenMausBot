// The stdio MCP servers a turn hands an agent (harness proxies and the person's own), shared by the ACP
// family and Muse Code so the owner's tool selection applies alike.
import type { SendTurnInput } from "../contracts.ts";
import { canUseMcpServer } from "../../shared/tool-scope.ts";
import { appMountFor, gateServer, mcpStdioServer, type AppMount } from "../mcp-gate-config.ts";

export interface TurnStdioMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** URL servers always go through OpenMausBot's remote proxy: agents' own MCP clients add capability
 * fields strict servers refuse. */
export function turnStdioMcpServers(turn: SendTurnInput): TurnStdioMcpServer[] {
  const servers: TurnStdioMcpServer[] = [];
  const observedCommands = new Map<string, AppMount>();
  const add = (name: string, server: { command: string; args: string[]; env?: Record<string, string> } | undefined) => {
    if (server) servers.push({ name, command: server.command, args: server.args, env: server.env ?? {} });
  };
  add("agents", turn.integrations?.agents);
  add("composio", turn.integrations?.composio);
  add("browser", turn.integrations?.browser);
  add("data", turn.integrations?.data);
  // Cua connections expose Cua Driver's own MCP server; a cloud turn runs on its boat, so none is mounted.
  add("computer", turn.integrations?.localComputer);
  // User servers after the built-ins: a residual name collision keeps the built-in.
  for (const [name, server] of Object.entries(turn.integrations?.custom ?? {})) {
    if (servers.some((existing) => existing.name === name)) continue;
    const apps = appMountFor(name, turn);
    if (apps && !("url" in server)) observedCommands.set(name, apps);
    const stdio = "url" in server ? mcpStdioServer(server, { nodeEnv: { ELECTRON_RUN_AS_NODE: "1" }, ...(apps ? { apps } : {}) })
      : apps && turn.toolScope === undefined ? gateServer({ name, server, threadId: turn.threadId, budget: 0, apps, nodeEnv: { ELECTRON_RUN_AS_NODE: "1" } })
      : server;
    if (!stdio) continue;
    servers.push({ name, command: stdio.command, args: stdio.args ?? [], env: stdio.env ?? {} });
  }
  if (turn.toolScope === undefined) return servers;
  return servers.filter((server) => canUseMcpServer(turn.toolScope, server.name)).map((server) => {
    const apps = observedCommands.get(server.name);
    const gated = gateServer({ name: server.name, server: { command: server.command, args: server.args, env: server.env },
      threadId: turn.threadId, budget: 0, toolScope: turn.toolScope, nodeEnv: { ELECTRON_RUN_AS_NODE: "1" }, ...(apps ? { apps } : {}) });
    if (!gated) throw new Error("Tool selection requires an MCP gate.");
    return { name: server.name, command: gated.command, args: gated.args, env: gated.env };
  });
}
