// OpenMausBot's own MCP servers (agents, browser, computer, data, email, device) reached by URL instead of a stdio proxy
// process each: every engine process otherwise starts one Node helper per server, about 7 threads each, all counted
// against a container's pids limit. The URL form is the endpoint those proxies forward to (routes/own-mcp-http.ts), with
// the same capability token, so identity and permissions are the stdio form's. The permission prompt server (ogb, over the
// turn's broker socket), the Android phone tools (which run adb themselves) and the person's own servers stay as they are.
import { botBox } from "../bot-box/box.ts";
import { cloudHomeConfigured } from "../cloud-home.ts";
import { ownMcpOverHttp } from "./turn-mcp.ts";

/** "1" or "0"; unset: on for a self-hosted Linux server, off on the desktop app, a Cloud and anything else. */
export const OWN_MCP_HTTP_ENV = "OMB_OWN_MCP_HTTP";

/** Whether engines get OpenMausBot's own servers by URL. Never while the bot box is on: a boxed engine reaches this server
 * only through the box's relays, which carry the stdio proxies' requests, not an engine's own. */
export function ownMcpHttpEnabled(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, boxed: boolean = botBox.enabled()): boolean {
  if (boxed) return false;
  if (env[OWN_MCP_HTTP_ENV] === "1") return true;
  if (env[OWN_MCP_HTTP_ENV] === "0") return false;
  return platform === "linux" && env.OMB_DESKTOP_PARENT !== "1" && !cloudHomeConfigured(env);
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

/** Turns every one of OpenMausBot's own proxies in a Claude --mcp-config into its HTTP form, when the setting is on. */
export function claudeOwnMcpOverHttp(servers: Record<string, unknown>, enabled: boolean = ownMcpHttpEnabled()): void {
  if (!enabled) return;
  for (const [name, server] of Object.entries(servers)) {
    const http = claudeOwnHttpMount(server);
    if (http) servers[name] = http;
  }
}

/** ACP engine instances whose agent said, in its `initialize` answer, that it reaches MCP servers by URL
 * (`agentCapabilities.mcpCapabilities.http`). The ACP spec lets a client send an `http` server only to such an agent. */
const acpHttpAgents = new Set<string>();

export function noteAcpMcpHttp(instanceId: string, init: unknown): void {
  const http = (init as { agentCapabilities?: { mcpCapabilities?: { http?: unknown } } } | null | undefined)?.agentCapabilities?.mcpCapabilities?.http;
  if (http === true) acpHttpAgents.add(instanceId);
  else acpHttpAgents.delete(instanceId);
}

/** An ACP engine gets OpenMausBot's own servers by URL once its agent has said it can take them (its first session starts
 * with the stdio form), unless its servers come from the launcher's own configuration. */
export function acpOwnMcpOverHttp(instanceId: string, fromLaunch: boolean, enabled: boolean = ownMcpHttpEnabled()): boolean {
  return enabled && !fromLaunch && acpHttpAgents.has(instanceId);
}
