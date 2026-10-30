import type { ConnectorScope, ConnectorScopes } from "../../shared/connector-scopes";
import type { ConnectorToolGrant } from "../../shared/wire";
import { isConnectorToolsRecordShape } from "./connector-grants";

interface AccessBot {
  composio?: boolean;
  connectorScopes?: ConnectorScopes;
  connectorTools?: Record<string, ConnectorToolGrant>;
}

/** A tool list without the app gives the bot none of its tools, whatever its scope. */
function toolsLeaveOut(bot: AccessBot, slug: string): boolean {
  return isConnectorToolsRecordShape(bot.connectorTools) && !Object.hasOwn(bot.connectorTools, slug);
}

export function botAppScope(bot: AccessBot, slug: string): ConnectorScope | null {
  if (bot.composio === false || toolsLeaveOut(bot, slug)) return null;
  if (!bot.connectorScopes) return "write";
  return bot.connectorScopes.apps[slug] ?? null;
}

export function withBotApp(
  scopes: ConnectorScopes | undefined,
  connected: readonly string[],
  slug: string,
  on: boolean,
): ConnectorScopes | undefined {
  if (!scopes) {
    if (on) return undefined;
    const apps: Record<string, ConnectorScope> = {};
    for (const other of connected) if (other !== slug) apps[other] = "write";
    return { apps };
  }
  const apps = { ...scopes.apps };
  if (on) {
    if (apps[slug]) return undefined;
    apps[slug] = "write";
  } else {
    if (!apps[slug]) return undefined;
    delete apps[slug];
  }
  return { apps };
}

/** The first app switched on while the bot's apps are off turns them on with only that app granted. */
export function appSwitchPatch(
  bot: AccessBot,
  connected: readonly string[],
  slug: string,
  on: boolean,
): AccessBot {
  const enabling = on && bot.composio === false;
  const connectorScopes = enabling && !bot.connectorScopes
    ? { apps: { [slug]: "write" as const } }
    : withBotApp(bot.connectorScopes, connected, slug, on);
  return {
    ...(enabling ? { composio: true } : {}),
    ...(connectorScopes ? { connectorScopes } : {}),
    ...(on && toolsLeaveOut(bot, slug) ? { connectorTools: { ...bot.connectorTools, [slug]: { tools: "*" as const } } } : {}),
  };
}
