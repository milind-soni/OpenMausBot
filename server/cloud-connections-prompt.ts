// What a bot on My Cloud is told about the connections it reaches for that need the person, or another computer, read
// from this Cloud's own state on each turn: an MCP server that needs a sign-in here, HighLevel or connected apps
// assigned to the bot but not connected here, an MCP server that runs on the person's computer, and what stayed on the
// computer the bots moved here from. So the bot says so in plain words, with the link that connects it.
import { HIGHLEVEL_SLUG } from "../shared/highlevel.ts";
import type { ConnectorToolGrant } from "../shared/wire.ts";
import { toolkitName } from "./activity.ts";
import type { McpAuthState } from "./mcp-oauth.ts";
import { isRemoteMcpServer, parseStoredMcpServer } from "./mcp-registry.ts";

const COMPOSIO_TTL_MS = 20_000;
const SLUG = /^[a-z0-9_][a-z0-9_-]{0,80}$/u;

export interface ConnectionPromptSources {
  mcpServers(): Record<string, unknown> | undefined;
  mcpAuth(name: string, url: string): McpAuthState;
  highlevelConnected(): boolean;
  /** Which of these connected apps are connected here now. */
  composioConnected(slugs: string[]): Promise<Record<string, boolean>>;
  /** The computer the bots moved here from, once a move is done. */
  movedFrom?(): string | null;
}

export type ConnectionPromptBot = { mcpServers?: string[]; composio?: boolean; connectorTools?: Record<string, ConnectorToolGrant> };

/** `origin`: My Cloud's public address, where `/?connect=<id>` opens the page that connects it. */
export function createConnectionPrompt(sources: ConnectionPromptSources, origin: string): (bot: ConnectionPromptBot) => string {
  const known = new Map<string, { at: number; connected: boolean }>();
  let reading: Promise<void> | null = null;
  let failedAt = 0;

  /** What is known of these apps now; any not read in the last 20 seconds is read in the background, for the next turn.
   * A read that failed waits 20 seconds too. */
  function connected(slugs: string[]): Array<[string, boolean]> {
    const stale = slugs.filter((slug) => Date.now() - (known.get(slug)?.at ?? 0) > COMPOSIO_TTL_MS);
    if (stale.length && !reading && Date.now() - failedAt > COMPOSIO_TTL_MS) {
      reading = sources.composioConnected(stale)
        .then((answer) => { const at = Date.now(); for (const slug of stale) known.set(slug, { at, connected: answer[slug] === true }); })
        .catch(() => { failedAt = Date.now(); })
        .finally(() => { reading = null; });
    }
    return slugs.flatMap((slug): Array<[string, boolean]> => { const entry = known.get(slug); return entry ? [[slug, entry.connected]] : []; });
  }

  const link = (id: string) => `${origin}/?connect=${encodeURIComponent(id)}`;

  return (bot) => {
    const toConnect: string[] = [];
    const elsewhere = new Map<string, string[]>();
    for (const [name, raw] of Object.entries(sources.mcpServers() ?? {})) {
      if (bot.mcpServers !== undefined && !bot.mcpServers.includes(name)) continue;
      const parsed = parseStoredMcpServer(name, raw);
      if (!parsed.ok || !parsed.server.enabled) continue;
      const server = parsed.server;
      if (server.runsOn) elsewhere.set(server.runsOn.label, [...elsewhere.get(server.runsOn.label) ?? [], name]);
      else if (isRemoteMcpServer(server)) {
        const auth = sources.mcpAuth(name, server.url);
        if (auth === "needs-sign-in" || (auth === "none" && server.oauth)) toConnect.push(`${name} (sign in here: ${link(`mcp:${name}`)})`);
      }
    }
    const granted = bot.composio === false ? [] : Object.keys(bot.connectorTools ?? {});
    if (granted.includes(HIGHLEVEL_SLUG) && !sources.highlevelConnected()) toConnect.push(`HighLevel (connect it here: ${link(HIGHLEVEL_SLUG)})`);
    const apps = connected(granted.filter((slug) => slug !== HIGHLEVEL_SLUG && SLUG.test(slug))).filter(([, on]) => !on).map(([slug]) => toolkitName(slug.toUpperCase()));
    const from = sources.movedFrom?.() ?? null;
    return [
      from ? ` You moved to My Cloud from the person's computer ${from}, with everything in OpenMausBot. What lives outside OpenMausBot stayed on ${from}: its other folders and files, passkeys, the person's own browser sessions and apps, Local VM disks and model servers on its home network. When a task needs one, use ${from} if it is lent to My Cloud and online; otherwise say in plain words that it stayed there.` : "",
      toConnect.length ? ` Not connected on My Cloud yet: ${toConnect.join("; ")}. When a task needs one, say in plain words that it needs the person once on My Cloud and give its link; do not try another way.` : "",
      apps.length ? ` Assigned to this bot but not connected on My Cloud yet: ${apps.join(", ")}. When a task needs one, call COMPOSIO_MANAGE_CONNECTIONS for it, which shows the person a card to connect it, and end the turn.` : "",
      ...[...elsewhere].map(([computer, names]) => ` Runs only on the person's computer ${computer}, not on My Cloud: ${names.join(", ")}. If a task needs one, say so in plain words.`),
    ].join("");
  };
}
