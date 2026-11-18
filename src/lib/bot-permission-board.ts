import type { Bot } from "@/state/store";
import { appSwitchPatch, botAppScope } from "./bot-app-access";
import { connectorServiceAccess } from "./connector-grants";
import { mcpServersForBot, mcpServersOfBot, mcpSwitch, type McpServerSummary } from "./mcp-servers";

export type PermissionResource =
  | { kind: "service"; key: string; label: string }
  | { kind: "mcp"; key: string; label: string; server: McpServerSummary };

export type PermissionReason = "otherBot" | "globallyOff" | "unavailable" | "unknownGrant";
export interface PermissionCell {
  checked: boolean;
  reason?: PermissionReason;
  warning?: PermissionReason;
  readOnly?: boolean;
  limited?: boolean;
}

export function permissionCell(bot: Bot, resource: PermissionResource, servers: McpServerSummary[]): PermissionCell {
  if (resource.kind === "service") {
    const grant = connectorServiceAccess(bot.connectorTools, resource.key);
    return {
      checked: botAppScope(bot, resource.key) !== null,
      readOnly: botAppScope(bot, resource.key) === "read",
      limited: grant.level === "partial",
      ...(!grant.editable ? { reason: "unknownGrant" as const } : {}),
    };
  }
  const server = resource.server;
  const checked = mcpServersForBot(servers, bot.mcpServers, bot.id).some(entry => entry.name === server.name);
  const reason: PermissionReason | undefined = server.bot && server.bot !== bot.id ? "otherBot"
    : !server.enabled ? "globallyOff"
    : undefined;
  return { checked, reason, ...(server.offFor?.includes(bot.id) ? { warning: "unavailable" as const } : {}) };
}

export function permissionPatch(bot: Bot, resource: PermissionResource, on: boolean, connected: string[], servers: McpServerSummary[]) {
  if (permissionCell(bot, resource, servers).reason) return null;
  if (resource.kind === "service") {
    const patch = appSwitchPatch(bot, connected, resource.key, on);
    return on && bot.composio === false
      ? { ...patch, connectorScopes: { apps: { [resource.key]: bot.connectorScopes?.apps[resource.key] ?? "write" } } }
      : patch;
  }
  const eligible = mcpServersOfBot(servers, bot.id);
  const selected = bot.mcpServers == null ? mcpServersForBot(eligible, null, bot.id).map(server => server.name) : bot.mcpServers;
  if (selected.includes(resource.key) === on) return null;
  return { mcpServers: mcpSwitch(eligible, selected, resource.key) };
}
