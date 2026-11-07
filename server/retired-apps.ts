// Retired connected apps. A bot saved by an older version may name one in connectorScopes.apps or connectorTools, where
// it would read as a Composio app the bot is limited to or must be told to connect, and the data folder may hold its
// sealed tokens: both go when the server starts.
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { ConnectorScopes } from "../shared/connector-scopes.ts";
import type { ConnectorToolGrant } from "../shared/wire.ts";

const RETIRED_APPS: readonly string[] = ["highlevel"];
/** A retired app's saved connection, the key that sealed it, and their half-written copies. */
const RETIRED_FILES = /^(?:highlevel\.json\.enc|highlevel-key)(?:$|\.\d+\.[0-9a-f-]+\.tmp$)/u;

const without = <T>(record: Record<string, T>, slugs: readonly string[]): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([slug]) => !slugs.includes(slug)));

/** Drops the retired apps from a bot's scopes and tool grants; true when the bot changed. A bot limited to them alone
 * stays limited, to no app, as before. */
export function dropRetiredApps(bot: { connectorScopes?: ConnectorScopes; connectorTools?: Record<string, ConnectorToolGrant> }): boolean {
  const scoped = bot.connectorScopes?.apps ? RETIRED_APPS.filter((slug) => Object.hasOwn(bot.connectorScopes!.apps, slug)) : [];
  const granted = bot.connectorTools && typeof bot.connectorTools === "object" ? RETIRED_APPS.filter((slug) => Object.hasOwn(bot.connectorTools!, slug)) : [];
  if (scoped.length) bot.connectorScopes = { ...bot.connectorScopes!, apps: without(bot.connectorScopes!.apps, scoped) };
  if (granted.length) bot.connectorTools = without(bot.connectorTools!, granted);
  return scoped.length > 0 || granted.length > 0;
}

/** Removes the retired apps' saved connections from the data folder; the names it removed. */
export function removeRetiredAppFiles(dataDir: string): string[] {
  let names: string[];
  try { names = readdirSync(dataDir); } catch { return []; }
  return names.filter((name) => {
    if (!RETIRED_FILES.test(name)) return false;
    try { rmSync(join(dataDir, name), { force: true }); return true; } catch { return false; }
  });
}
