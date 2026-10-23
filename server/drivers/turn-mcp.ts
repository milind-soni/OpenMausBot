// The stdio MCP servers a turn hands an agent (harness proxies and the person's own), shared by the ACP
// family and Muse Code so the owner's tool selection applies alike.
import type { SendTurnInput } from "../contracts.ts";
import { canUseMcpServer } from "../../shared/tool-scope.ts";
import { harnessMcpTokenEnv } from "../harness-mcp-token.ts";
import { appMountFor, gateServer, mcpStdioServer, type AppMount } from "../mcp-gate-config.ts";
import { AGENTS_ENV_HEADER, OWN_MCP_HTTP_PATH } from "../routes/own-mcp-http-path.ts";
import { TOOL_SCHEMA_PROFILE_ENV, toolSchemaProfileFor, type ToolSchemaProfileId } from "../tool-schema-profile.ts";
import { AGENTS_MCP_ENV } from "./agents-mcp-env.ts";
import { OWN_APPS_SERVER } from "../../shared/own-apps.ts";

export interface TurnStdioMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** URL servers always go through OpenMausBot's remote proxy: agents' own MCP clients add capability
 * fields strict servers refuse. Under a schema profile OpenMausBot fits every tool list: its own proxies and gates read
 * the profile, and the person's stdio servers go through a gate. */
export function turnStdioMcpServers(turn: SendTurnInput, options: { schemaProfile?: ToolSchemaProfileId } = {}): TurnStdioMcpServer[] {
  const { schemaProfile } = options;
  const servers: TurnStdioMcpServer[] = [];
  const observedCommands = new Map<string, AppMount>();
  const add = (name: string, server: { command: string; args: string[]; env?: Record<string, string> } | undefined) => {
    if (server) servers.push({ name, command: server.command, args: server.args, env: server.env ?? {} });
  };
  add("agents", turn.integrations?.agents);
  add("composio", turn.integrations?.composio);
  add(OWN_APPS_SERVER, turn.integrations?.composioOwn);
  add("browser", turn.integrations?.browser);
  add("data", turn.integrations?.data);
  add("highlevel", turn.integrations?.highlevel);
  // Cua connections expose Cua Driver's own MCP server; a cloud turn runs on its boat, so none is mounted.
  add("computer", turn.integrations?.localComputer);
  // User servers after the built-ins: a residual name collision keeps the built-in.
  for (const [name, server] of Object.entries(turn.integrations?.custom ?? {})) {
    if (servers.some((existing) => existing.name === name)) continue;
    const apps = appMountFor(name, turn);
    if (apps && !("url" in server)) observedCommands.set(name, apps);
    const stdio = "url" in server ? mcpStdioServer(server, { nodeEnv: { ELECTRON_RUN_AS_NODE: "1" }, ...(apps ? { apps } : {}) })
      : (apps || schemaProfile) && turn.toolScope === undefined
        ? gateServer({ name, server, threadId: turn.threadId, budget: 0, nodeEnv: { ELECTRON_RUN_AS_NODE: "1" }, ...(apps ? { apps } : {}), schemaProfile })
      : server;
    if (!stdio) continue;
    servers.push({ name, command: stdio.command, args: stdio.args ?? [], env: stdio.env ?? {} });
  }
  const profiled = (server: TurnStdioMcpServer) =>
    schemaProfile ? { ...server, env: { ...server.env, [TOOL_SCHEMA_PROFILE_ENV]: schemaProfile } } : server;
  if (turn.toolScope === undefined) return servers.map(profiled);
  return servers.filter((server) => canUseMcpServer(turn.toolScope, server.name)).map((server) => {
    const apps = observedCommands.get(server.name);
    const gated = gateServer({ name: server.name, server: { command: server.command, args: server.args, env: server.env },
      threadId: turn.threadId, budget: 0, toolScope: turn.toolScope, nodeEnv: { ELECTRON_RUN_AS_NODE: "1" }, ...(apps ? { apps } : {}), schemaProfile });
    if (!gated) throw new Error("Tool selection requires an MCP gate.");
    return profiled({ name: server.name, command: gated.command, args: gated.args, env: gated.env });
  });
}

type NameValue = Array<{ name: string; value: string }>;
export type AcpMcpServer = { name: string; command: string; args: string[]; env: NameValue }
  | { type: "http"; name: string; url: string; headers: NameValue };

const HARNESS_KINDS = ["browser", "computer", "data", "highlevel"] as const;

/** OpenMausBot's own server behind a stdio proxy, as its HTTP endpoint on this server; null for any other server (the
 * person's, or one wrapped in a tool-selection gate). */
export function ownMcpOverHttp(server: TurnStdioMcpServer): { url: string; headers: Record<string, string> } | null {
  const harness = server.env.OMB_HARNESS_URL;
  if (!harness || !/^http:\/\/127\.0\.0\.1:\d+$/.test(harness)) return null;
  const script = server.args.findIndex((arg) => /(?:^|[\\/])(?:harness-mcp-proxy|agents-proxy)\.[jt]s$/.test(arg));
  if (script < 0) return null;
  if (/agents-proxy\.[jt]s$/.test(server.args[script]!)) {
    const token = server.env.OMB_COMMS_TOKEN;
    if (!token) return null;
    const settings = Object.fromEntries(AGENTS_MCP_ENV.flatMap((key) => server.env[key] === undefined ? [] : [[key, server.env[key]]]));
    return { url: `${harness}${OWN_MCP_HTTP_PATH}agents`, headers: { authorization: `Bearer ${token}`,
      [AGENTS_ENV_HEADER]: Buffer.from(JSON.stringify(settings)).toString("base64url") } };
  }
  const kind = HARNESS_KINDS.find((candidate) => candidate === server.args[script + 1]);
  const token = kind && server.env[harnessMcpTokenEnv(kind)];
  return kind && token ? { url: `${harness}${OWN_MCP_HTTP_PATH}${kind}`, headers: { authorization: `Bearer ${token}` } } : null;
}

/** The turn's MCP servers as ACP session/new takes them. stdio is the baseline every ACP agent supports; an agent that
 * reaches servers by URL (`http`) gets OpenMausBot's own as endpoints of this server instead of a proxy process each.
 * `engine` is the driver kind, whose provider may limit each tool's schema. */
export function acpMcpServers(turn: SendTurnInput, options: { http?: boolean; engine?: string } = {}): AcpMcpServer[] {
  const schemaProfile = toolSchemaProfileFor({ engine: options.engine })?.id;
  return turnStdioMcpServers(turn, { schemaProfile }).map((server) => {
    const own = options.http ? ownMcpOverHttp(server) : null;
    const pairs = (record: Record<string, string>) => Object.entries(record).map(([name, value]) => ({ name, value: String(value) }));
    return own ? { type: "http", name: server.name, url: own.url, headers: pairs(own.headers) } : { ...server, env: pairs(server.env) };
  });
}
