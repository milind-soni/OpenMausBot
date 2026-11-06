import type { McpServerSpec, StdioMcpSpec } from "../contracts.ts";
import { BOX_NO_PROXY_ENV, BOX_PROXY_ENV, botBox } from "../bot-box/box.ts";
import { MCP_RESTART_ENV } from "../mcp-app-catalog.ts";
import { isReservedMcpEnvEntry } from "../mcp-registry.ts";
import { tomlInlineTable } from "./codex-process.ts";

/** Codex's default for one MCP server's tools (openai/codex#17843): "auto"
 * runs without asking only tools the server marks read-only, "approve" runs
 * every tool without asking, "prompt" asks for each call. */
export type McpApprovalMode = "approve" | "auto" | "prompt";

export function mountMcpServer(
  appServerArgs: string[],
  env: Record<string, string | undefined>,
  name: string,
  server: StdioMcpSpec,
  approval: McpApprovalMode = "auto",
  /** Written into the mount's own `env` table: its process gets them, Codex's command shell does not. */
  literalEnv: Record<string, string> = {},
  written: Set<string> = new Set(),
  /** More names Codex hands the server from its own environment; a name it does not have is skipped. */
  forward: readonly string[] = [],
): void {
  const prefix = `mcp_servers.${name}`;
  Object.assign(env, server.env);
  for (const name of Object.keys(server.env)) written.add(name);
  appServerArgs.push(
    "-c", `${prefix}.command=${JSON.stringify(server.command)}`,
    "-c", `${prefix}.args=${JSON.stringify(server.args)}`,
    // argv carries names only, so credentials never appear in process listings.
    "-c", `${prefix}.env_vars=${JSON.stringify([...new Set([...Object.keys(server.env), ...forward])])}`,
  );
  if (Object.keys(literalEnv).length) appServerArgs.push("-c", `${prefix}.env=${tomlInlineTable(literalEnv)}`);
  if (approval !== "prompt") appServerArgs.push("-c", `${prefix}.default_tools_approval_mode="${approval}"`);
}

/** A Codex app-server and its MCP servers live for one turn, so the next turn already starts a restarted server afresh. */
export function codexCustomServers(custom: Record<string, McpServerSpec> = {}): Array<[string, McpServerSpec]> {
  return Object.entries(custom).map(([name, server]) => {
    if ("url" in server) return [name, server];
    const { [MCP_RESTART_ENV]: _restarts, ...env } = server.env;
    const reserved = Object.entries(env).find(([key, value]) => isReservedMcpEnvEntry(key, value));
    if (reserved) throw new Error(`Custom MCP server “${name}” cannot set reserved environment variable “${reserved[0]}”`);
    return [name, { ...server, env }];
  });
}

/** In the bot box the network is reached only through the box's proxy (bot-box/box.ts), and Codex starts an MCP server with
 * just a few env names plus env_vars: a person's own stdio server would otherwise look hosts up itself and fail. */
export function boxProxyEnvNames(boxed: boolean = botBox.enabled()): string[] {
  return boxed ? [...BOX_PROXY_ENV, ...BOX_NO_PROXY_ENV] : [];
}
