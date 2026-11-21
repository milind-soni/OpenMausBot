// The grant key binds approval to the instance, the exact MCP server/tool and that server's config, so editing the server invalidates it.
import { createHash } from "node:crypto";

import { isOutboundTool } from "../shared/outbound.ts";

/** The app's own bridges: their launch carries a token for one turn, so a grant names the bridge instead. */
const BUILTIN_SERVERS: ReadonlySet<string> = new Set(["composio", "own_apps", "agents", "browser", "data", "device", "email", "dweb"]);
/** Tools that drive a computer or a phone: each use is asked, never remembered. */
const CONTROLS_A_DEVICE: ReadonlySet<string> = new Set(["computer", "phone", "openmausbot_phone"]);
const CONTROL_TOOLS: ReadonlySet<string> = new Set(["agents:shared_computer"]);

/** What a grant on `server` is tied to: the server as configured, a built-in bridge by its name, or nothing for a server
 * neither configured nor built in. */
export function providerToolConfig(server: string, configured: Record<string, unknown>): unknown {
  if (Object.hasOwn(configured, server)) return configured[server];
  return BUILTIN_SERVERS.has(server) ? { builtin: server } : undefined;
}

export interface ProviderMcpTool {
  server: string;
  tool: string;
}

/** Provider-facing MCP tool names are mcp__<server>__<tool>. */
export function providerMcpTool(name: string): ProviderMcpTool | null {
  if (!name.startsWith("mcp__")) return null;
  const parts = name.split("__");
  if (parts.length < 3 || parts[0] !== "mcp" || !parts[1] || !parts.slice(2).join("__")) return null;
  return { server: parts[1], tool: parts.slice(2).join("__") };
}

/** A durable key for any exact tool that sends nothing and drives no computer or phone; null for everything else. */
export function providerToolAllowKey(
  providerInstanceId: string,
  name: string,
  serverConfig: unknown,
): string | null {
  const parsed = providerMcpTool(name);
  if (!parsed || !providerInstanceId || serverConfig === undefined || isOutboundTool(name)) return null;
  if (CONTROLS_A_DEVICE.has(parsed.server) || CONTROL_TOOLS.has(`${parsed.server}:${parsed.tool}`)) return null;
  const fingerprint = createHash("sha256").update(JSON.stringify(serverConfig)).digest("hex").slice(0, 16);
  return `provider-tool:${providerInstanceId}:${parsed.server}:${parsed.tool}:${fingerprint}`;
}

/** Whether `key` is saved for this turn: in the thread's own list, or in its bot's, which Settings → Access shows. A
 * grant reaches every conversation of the bot, one opened before it was saved and one whose own list was reset alike;
 * removing it there takes it from both. */
export function savedToolGrant(key: string | null, ...lists: Array<readonly string[] | undefined>): boolean {
  return key !== null && lists.some((list) => list?.includes(key) === true);
}
