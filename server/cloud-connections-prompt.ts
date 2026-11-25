// What a bot on My Cloud is told about the connections it reaches for that need the person, or another computer, read
// from this Cloud's own state on each turn: an MCP server that needs a sign-in here, connected apps assigned to the
// bot but not connected here, an MCP server that runs on the person's computer, and what stayed on the
// computer the bots moved here from. So the bot says so in plain words, with the link that connects it.
import type { ConnectorToolGrant } from "../shared/wire.ts";
import { toolkitName } from "./activity.ts";
import type { McpAuthState } from "./mcp-oauth.ts";
import { isRemoteMcpServer, parseStoredMcpServer } from "./mcp-registry.ts";
import { signsInOnlyElsewhere, type McpServerApp } from "./mcp-server-app.ts";
import { stayedConnectors, stayedWhyText } from "./cloud-connections-stayed.ts";

const COMPOSIO_TTL_MS = 20_000;
const SLUG = /^[a-z0-9_][a-z0-9_-]{0,80}$/u;

export interface ConnectionPromptSources {
  mcpServers(): Record<string, unknown> | undefined;
  mcpAuth(name: string, url: string): McpAuthState;
  /** Which of these connected apps are connected here now. */
  composioConnected(slugs: string[]): Promise<Record<string, boolean>>;
  /** The computer the bots moved here from, once a move is done. */
  movedFrom?(): string | null;
  /** The programs this Cloud has. */
  programs?(): readonly string[];
}

export type ConnectionPromptBot = { mcpServers?: string[]; composio?: boolean; connectorTools?: Record<string, ConnectorToolGrant> };

/** The connected app a server stands for, when this turn could use that app instead: the same rule the turn's MCP servers
 * are swapped by (team-connections-host.ts `mcpServerApps`). */
export type ConnectionPromptAppFor = (name: string, url: string) => McpServerApp | null;

/** `origin`: My Cloud's public address, where `/?connect=<id>` opens the page that connects it. `lent`, in a turn: by
 * name, why each of the bot's servers that runs on the person's computer can't be reached now; one left out reaches the
 * turn through that computer. `appFor`, in a turn: the connected app each server stands for. */
export function createConnectionPrompt(sources: ConnectionPromptSources, origin: string): (bot: ConnectionPromptBot, lent?: ReadonlyMap<string, string>, appFor?: ConnectionPromptAppFor) => string {
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

  return (bot, lent, appFor) => {
    const toConnect: string[] = [];
    const inApps: string[] = [];
    const alsoApps: string[] = [];
    const elsewhereOnly: string[] = [];
    const elsewhere = new Map<string, string[]>();
    for (const stayed of stayedConnectors(sources.mcpServers(), sources.programs?.() ?? [])) {
      if (bot.mcpServers !== undefined && !bot.mcpServers.includes(stayed.name)) continue;
      elsewhere.set(stayed.computer, [...elsewhere.get(stayed.computer) ?? [], `${stayed.name} (${stayedWhyText(stayed)})`]);
    }
    for (const [name, raw] of Object.entries(sources.mcpServers() ?? {})) {
      if (bot.mcpServers !== undefined && !bot.mcpServers.includes(name)) continue;
      const parsed = parseStoredMcpServer(name, raw);
      if (!parsed.ok || !parsed.server.enabled) continue;
      const server = parsed.server;
      if (!server.runsOn && isRemoteMcpServer(server)) {
        const auth = sources.mcpAuth(name, server.url);
        if (auth !== "needs-sign-in" && !(auth === "none" && server.oauth)) continue;
        const app = appFor?.(name, server.url) ?? null, signIn = `sign in here: ${link(`mcp:${name}`)}`;
        // A server that can only sign in elsewhere never gets a link; one that can keeps it beside its connected app.
        if (signsInOnlyElsewhere(server.url)) {
          if (app?.connected) inApps.push(`${name} (${app.label})`);
          else elsewhereOnly.push(app ? `${name} (connect ${app.label} as a connected app instead)` : name);
        } else if (app?.connected) alsoApps.push(`${name} (${signIn}; connected app: ${app.label})`);
        else toConnect.push(`${name} (${signIn})`);
      }
    }
    const granted = bot.composio === false ? [] : Object.keys(bot.connectorTools ?? {});
    const apps = connected(granted.filter((slug) => SLUG.test(slug))).filter(([, on]) => !on).map(([slug]) => toolkitName(slug.toUpperCase()));
    const from = sources.movedFrom?.() ?? null;
    return [
      from ? ` You moved to My Cloud from the person's computer ${from}, with everything in OpenMausBot. What lives outside OpenMausBot stayed on ${from}: its other folders and files, passkeys, the person's own browser sessions and apps, Local VM disks and model servers on its home network. When a task needs one, use ${from} if it is lent to My Cloud and online; otherwise say in plain words that it stayed there.` : "",
      toConnect.length ? ` Not connected on My Cloud yet: ${toConnect.join("; ")}. When a task needs one, say in plain words that it needs the person once on My Cloud and give its link; do not try another way.` : "",
      inApps.length ? ` Not signed in on My Cloud, but connected here as connected apps: ${inApps.join("; ")}. When a task needs one, use that connected app through the composio tools instead; do not send the person to sign in to the server.` : "",
      alsoApps.length ? ` Not signed in on My Cloud yet, and also connected here as connected apps: ${alsoApps.join("; ")}. When a task needs one, use the connected app through the composio tools; give the server's link only when the task needs that server itself.` : "",
      elsewhereOnly.length ? ` Can't be signed in from OpenMausBot (their sign-in works only in another app): ${elsewhereOnly.join("; ")}. When a task needs one, do not send the person to sign in to it; where a connected app is named, call COMPOSIO_MANAGE_CONNECTIONS for it, which shows the person a card to connect it, and end the turn; otherwise say so in plain words.` : "",
      apps.length ? ` Assigned to this bot but not connected on My Cloud yet: ${apps.join(", ")}. When a task needs one, call COMPOSIO_MANAGE_CONNECTIONS for it, which shows the person a card to connect it, and end the turn.` : "",
      ...(lent
        ? (lent.size ? [` Runs on the person's own computer and can't be reached now: ${[...lent.values()].join(" ")} If a task needs one, tell the person that in plain words, and do not write your own replacement.`] : [])
        : [...elsewhere].map(([computer, names]) => ` Runs only on the person's computer ${computer}, not on My Cloud: ${names.join("; ")}. It worked there before the bots moved here. If a task needs one, tell the person in plain words that it stayed on ${computer} and why, not that it was never set up, and do not write your own replacement.`)),
    ].join("");
  };
}
