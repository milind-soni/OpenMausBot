// OpenMausBot's own MCP servers (agents, browser, computer, data, email, device) reached by URL instead of a stdio proxy
// process each: every engine process otherwise starts one Node helper per server, about 7 threads each, all counted
// against a container's pids limit. The URL form is the endpoint those proxies forward to (routes/own-mcp-http.ts), with
// the same capability token, so identity and permissions are the stdio form's. The permission prompt server (ogb, over the
// turn's broker socket), the Android phone tools (which run adb themselves) and the person's own servers stay as they are.
// In the bot box with its own network, the engine reaches that endpoint as its stdio proxies do: 127.0.0.1 at the server's
// port is the box's bridge to the harness gate (bot-box/harness-gate.ts), which passes /api/internal/ only, and the box
// keeps loopback out of its egress proxy (NO_PROXY).
import { botBox } from "../bot-box/box.ts";
import { acpOwnServersOverHttp, ownMcpOverHttp, type AcpMcpServer } from "./turn-mcp.ts";

/** "1" turns the URL form on for every engine that can take it; "0" keeps every engine on stdio proxies, the ACP agents
 * that take the URL form by default included. */
export const OWN_MCP_HTTP_ENV = "OMB_OWN_MCP_HTTP";

/** Whether Claude, Codex and the ACP agents that do not take the URL form by default get OpenMausBot's own servers by URL:
 * only with OMB_OWN_MCP_HTTP=1, and not while the bot box is on, where their HTTP clients have not been checked. */
export function ownMcpHttpEnabled(env: NodeJS.ProcessEnv = process.env, boxed: boolean = botBox.enabled()): boolean {
  return !boxed && env[OWN_MCP_HTTP_ENV] === "1";
}

const LOOPBACK = ["127.0.0.1", "localhost", "::1"];

/** An engine set up to use a proxy for HTTP (HTTPS_PROXY, ALL_PROXY) would send its calls to this server's loopback URL
 * there too: the loopback names join NO_PROXY and no_proxy, both spellings, keeping whatever either held. */
export function withLoopbackNoProxy(env: Record<string, string | undefined>): void {
  const hosts = [env.NO_PROXY, env.no_proxy].flatMap((value) => (value ?? "").split(",")).map((host) => host.trim()).filter(Boolean);
  env.NO_PROXY = env.no_proxy = [...new Set([...hosts, ...LOOPBACK])].join(",");
}

/** `http` as given; an engine that will reach this server by URL gets the loopback names in its NO_PROXY first. */
export function loopbackUnproxied(env: Record<string, string | undefined>, http: boolean): boolean {
  if (http) withLoopbackNoProxy(env);
  return http;
}

type StdioMount = { command?: unknown; args?: unknown; env?: unknown; alwaysLoad?: unknown };

/** One --mcp-config entry as Claude Code's HTTP form when it is one of OpenMausBot's own stdio proxies (Claude Code 1.0.60,
 * 2.0.0, 2.1.257 and 2.1.325 checked: `type: "http"` with headers connects and lists tools), else null. `alwaysLoad` stays. */
export function claudeOwnHttpMount(server: unknown): Record<string, unknown> | null {
  const mount = server as StdioMount | null;
  if (!mount || typeof mount.command !== "string" || !Array.isArray(mount.args) || !mount.env || typeof mount.env !== "object") return null;
  const http = ownMcpOverHttp({ name: "", command: mount.command, args: mount.args.map(String), env: mount.env as Record<string, string> });
  return http ? { type: "http", url: http.url, headers: http.headers, ...(mount.alwaysLoad === true ? { alwaysLoad: true } : {}) } : null;
}

/** Turns every one of OpenMausBot's own proxies in a Claude --mcp-config into its HTTP form, when the setting is on;
 * true when any was. */
export function claudeOwnMcpOverHttp(servers: Record<string, unknown>, enabled: boolean = ownMcpHttpEnabled()): boolean {
  if (!enabled) return false;
  let converted = false;
  for (const [name, server] of Object.entries(servers)) {
    const http = claudeOwnHttpMount(server);
    if (http) { servers[name] = http; converted = true; }
  }
  return converted;
}

/** How an ACP engine's turn gets OpenMausBot's own servers: `http` in every session, `advertised` in a session whose agent
 * said in its `initialize` answer that it reaches MCP servers by URL (`agentCapabilities.mcpCapabilities.http`; the ACP spec
 * lets a client send an `http` server only to such an agent), else `stdio`. */
export type AcpOwnMcpTransport = "http" | "advertised" | "stdio";

export function acpOwnMcpTransport(support: { ownMcpOverHttp?: boolean | "advertised"; mcpServersFromLaunch?: boolean },
  env: NodeJS.ProcessEnv = process.env, boxed: boolean = botBox.enabled()): AcpOwnMcpTransport {
  if (support.mcpServersFromLaunch === true || env[OWN_MCP_HTTP_ENV] === "0") return "stdio";
  if (support.ownMcpOverHttp === true) return "http";
  if (support.ownMcpOverHttp === "advertised") return "advertised";
  return ownMcpHttpEnabled(env, boxed) ? "advertised" : "stdio";
}

export function acpAgentTakesHttpMcp(init: unknown): boolean {
  return (init as { agentCapabilities?: { mcpCapabilities?: { http?: unknown } } } | null | undefined)?.agentCapabilities?.mcpCapabilities?.http === true;
}

/** The servers a session/new or session/load sends: under `advertised`, OpenMausBot's own as this server's endpoints when
 * the session's agent takes them, by its `initialize` answer or, for an agent that takes them without saying so, by
 * `takesUnadvertised`. Deciding here, after `initialize`, lets an agent's first session use the URL form too. */
export function acpSessionMcpServers(servers: AcpMcpServer[], transport: AcpOwnMcpTransport, init: unknown,
  takesUnadvertised?: (init: unknown) => boolean): AcpMcpServer[] {
  return transport === "advertised" && (acpAgentTakesHttpMcp(init) || takesUnadvertised?.(init) === true) ? acpOwnServersOverHttp(servers) : servers;
}
