// The grant key binds approval to the instance, the exact MCP server/tool and that server's config, so editing the server invalidates it.
import { createHash } from "node:crypto";

import { isOutboundTool } from "../shared/outbound.ts";

const BUILTIN_SERVERS = new Set(["composio", "own_apps", "agents", "browser", "data", "device", "phone", "email", "dweb"]);

/** Built-in bridge tokens belong to one turn; the tool's approval identity belongs to the workspace. */
export function providerToolConfig(server: string, configured: Record<string, unknown>): unknown {
  if (Object.hasOwn(configured, server)) return configured[server];
  return BUILTIN_SERVERS.has(server) ? { builtin: server } : undefined;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
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

export function providerToolAllowKey(
  providerInstanceId: string,
  name: string,
  serverConfig: unknown,
): string | null {
  const parsed = providerMcpTool(name);
  if (!parsed || !providerInstanceId || serverConfig === undefined || parsed.server === "computer" || isOutboundTool(name)) return null;
  const fingerprint = createHash("sha256").update(JSON.stringify(canonical(serverConfig))).digest("hex").slice(0, 16);
  return `provider-tool:${providerInstanceId}:${parsed.server}:${parsed.tool}:${fingerprint}`;
}

export function legacyProviderToolAllowKey(instance: string, name: string, config: unknown): string | null {
  const key = providerToolAllowKey(instance, name, config);
  if (!key) return null;
  return key.slice(0, -16) + createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 16);
}

export function rememberedProviderTool(keys: readonly string[] | undefined, current: string | null, legacy: string | null): boolean {
  return Boolean(keys && ((current && keys.includes(current)) || (legacy && keys.includes(legacy))));
}
