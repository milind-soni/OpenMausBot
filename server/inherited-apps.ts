import { botOwner, type OwnedBot } from "../shared/bot-owner.ts";
import type { ConnectorScopes } from "../shared/connector-scopes.ts";
import type { BotVisibility, ConnectorToolGrant } from "../shared/wire.ts";

/** What a bot may use of the connected apps: the switch, each app's tools and read or write level, its MCP servers. */
export interface AppGrants {
  composio?: boolean;
  connectorTools?: Record<string, ConnectorToolGrant>;
  connectorScopes?: ConnectorScopes;
  mcpServers?: string[];
}

type Placed = Pick<OwnedBot, "createdBy" | "reportsTo" | "defaultBot"> & { visibility?: BotVisibility };

const GRANTS = ["composio", "connectorTools", "connectorScopes", "mcpServers"] as const;
const audience = (bot: Placed) => JSON.stringify(bot.visibility ?? "everyone");

/** The connected apps a bot a Chief creates starts with: a copy of the Chief's own grants and levels, never more.
 * Security: only a bot with the Chief's owner and exactly the Chief's audience gets them, so nobody reaches an app
 * through it that they could not reach through the Chief; any other starts with connected apps and MCP servers off.
 * On a Team Cloud a grant names an app, never a connection: whose connection a turn uses stays the relay's call. */
export function appsFromCreator(creator: AppGrants & Placed, created: Placed): AppGrants {
  if (botOwner(creator) !== botOwner(created) || audience(creator) !== audience(created)) {
    return { composio: false, connectorTools: {}, mcpServers: [] };
  }
  const grants: AppGrants = {};
  for (const key of GRANTS) if (creator[key] !== undefined) Object.assign(grants, { [key]: structuredClone(creator[key]) });
  // Absent would mean every tool once connected apps are turned on.
  if (grants.composio === false) grants.connectorTools ??= {};
  return grants;
}
