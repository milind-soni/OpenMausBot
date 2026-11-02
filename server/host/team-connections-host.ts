// Whose connection a turn on a Team Cloud may use. The team's connections serve every turn; a `person` app or MCP server
// is offered to a turn only for the person it acts for (server/host/acting-person.ts), and only in that person's own
// private chat, where nobody else reads what it brings back. Work their own message started in a group chat or the bot's
// main chat reaches their own connections by being handed on (handOnFor): it opens in the receiving bot's chat with them,
// and the shared place gets only a line saying where the result is (acting-person.ts privateHandBack).
// Security: nothing else ever gets a member's connection: not another person's request or the work it hands on, not a
// turn someone else wrote into, not a chat anyone else reads, a routine or a webhook. The relay checks it again on every
// call. Off a team nothing changes.
import { createHash } from "node:crypto";
import { join } from "node:path";

import { audienceMember, type Audience } from "../audience.ts";
import type { CloudTeam, TeamRole } from "../cloud-team.ts";
import type * as Composio from "../composio.ts";
import type { AppConfig } from "../config.ts";
import type { McpServerSpec } from "../contracts.ts";
import { serviceSlugFor } from "../connector-verdict.ts";
import { type McpOAuthManager, withMcpSignIn, withoutPendingSignIn } from "../mcp-oauth.ts";
import { isRemoteMcpServer, parseStoredMcpServer } from "../mcp-registry.ts";
import { OWN_APPS_SERVER } from "../../shared/own-apps.ts";
import { appLabel, ConnectionScopes, PeopleConnections, personAppOf, SCOPES_FILE, type BrokerAccess } from "../team-connections.ts";
import { APP_TOOL_NAMES_ENV, APP_TOOLS_ENV, appToolsFor } from "../connector-app-tools.ts";
import type { ConnectorScopes } from "../../shared/connector-scopes.ts";

type Bot = { id: string; name: string; connectorTools?: Parameters<typeof Composio.mcpIntegration>[1]["connectorTools"]; connectorScopes?: ConnectorScopes };
type Integration = { command: string; args: string[]; env: Record<string, string> };
type McpBot = { id: string; name: string; mcpServers?: string[] };

export interface TeamConnectionsHostDeps {
  team: CloudTeam | null;
  dataDir: string;
  cfg: () => AppConfig;
  /** The Admin's origin (OMB_CLOUD_ADMIN_URL): a member connects their own on their team's page there. */
  adminOrigin: string | null;
  harnessUrl: string;
  audienceOf(threadId: string): Audience;
  /** The person this turn generation acts for (the latest one when none is named), or null: server/host/acting-person.ts. */
  requester(threadId: string, generation?: string): string | null;
  /** What a person is called in a bot's words: the name they chose, else their address. */
  personName?(person: string): string | undefined;
  /** The members the Admin paired here, by person key, with their address and role (server/team-people.ts). */
  roster?(): ReadonlyArray<{ person: string; email: string; role: TeamRole }>;
  /** A `connectors` capability for this turn; `connectorsFor` makes it the member's own bridge's. */
  mint(capability: { botId: string; threadId: string; generation: string; connectorsFor?: string }): string;
  mcpOAuth: McpOAuthManager;
  /** The bot's enabled MCP servers, as policy allows them, before any sign-in is attached. */
  botMcp(bot: McpBot): Record<string, McpServerSpec>;
  isSessionLive(id: string): boolean;
  /** The connected-apps service a member's own installation is made on; null: none here. */
  brokerUrl(): string | null;
  composio: Pick<typeof Composio, "configured" | "mcpIntegration" | "connectedServices" | "connectedServiceSlugs" | "authorizeService" | "removeService">;
}

const list = (names: readonly string[]) => names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/** How long a read of an installation's connected apps stands, how soon a failed first read is tried again, and how long a
 * turn waits for an installation's first answer. */
const APPS_FRESH_MS = 60_000, APPS_RETRY_MS = 10_000, FIRST_APPS_WAIT_MS = 3_000;

export function createTeamConnectionsHost(deps: TeamConnectionsHostDeps) {
  const team = deps.team;
  const scopes = new ConnectionScopes(join(deps.dataDir, SCOPES_FILE));
  /** The sign-in app an admin set for a server (config.json), read when a member signs in: never copied anywhere. */
  const teamServer = (name: string) => {
    const raw = deps.cfg().mcpServers?.[name];
    const parsed = raw === undefined ? null : parseStoredMcpServer(name, raw);
    return parsed?.ok ? parsed.server : null;
  };
  const people = new PeopleConnections({
    dataDir: deps.dataDir,
    brokerUrl: deps.brokerUrl,
    clients: (name, url) => { const server = teamServer(name); return server && isRemoteMcpServer(server) && server.url === url ? server.oauth : undefined; },
    isOwnerLive: deps.isSessionLive,
  });
  const personApps = () => (team ? scopes.person("app") : []);
  /** The apps connected for an installation, the team's or a member's own. A turn never waits on a refresh: what is known
   * is used at once, and read again in the background once it is a minute old. Only an installation's first answer is
   * waited for, at most a few seconds, and a failed first read is tried again soon; `primeApps` reads the team's at start. */
  const connectedApps = new Map<string, { at: number; apps: string[] | null; reading: Promise<void> | null }>();
  const appsConnected = async (as?: BrokerAccess): Promise<string[]> => {
    const key = as ? createHash("sha256").update(as.url).update("\u0000").update(as.token).digest("hex") : "";
    const entry = connectedApps.get(key) ?? { at: -Infinity, apps: null, reading: null };
    connectedApps.set(key, entry);
    if (!entry.reading && Date.now() - entry.at >= (entry.apps ? APPS_FRESH_MS : APPS_RETRY_MS)) {
      entry.reading = deps.composio.connectedServices(deps.cfg(), as).then((services) => {
        entry.apps = Object.entries(services).filter(([, state]) => state.connected).map(([slug]) => slug);
      }, () => {}).finally(() => { entry.at = Date.now(); entry.reading = null; });
    }
    if (!entry.apps && entry.reading) {
      await Promise.race([entry.reading, new Promise<void>((resolve) => { setTimeout(resolve, FIRST_APPS_WAIT_MS).unref?.(); })]);
    }
    return entry.apps ?? [];
  };
  const withAppTools = async (bridge: Integration, bot: Bot, names: "dotted" | "plain", as?: BrokerAccess): Promise<Integration> => {
    const tools = appToolsFor(bot, await appsConnected(as));
    return tools.length ? { ...bridge, env: { ...bridge.env, [APP_TOOLS_ENV]: JSON.stringify(tools), [APP_TOOL_NAMES_ENV]: names } } : bridge;
  };
  const personMcp = () => (team ? scopes.person("mcp") : []);
  const link = () => (team && deps.adminOrigin ? `${deps.adminOrigin}/cloud/team/${encodeURIComponent(team.id)}` : null);
  const without = <T,>(servers: Record<string, T>, names: readonly string[]) =>
    Object.fromEntries(Object.entries(servers).filter(([name]) => !names.includes(name)));

  /** The member a turn acts for, in a chat nobody else reads: theirs. */
  const actingFor = (threadId: string, generation?: string): string | null => (team ? deps.requester(threadId, generation) : null);
  /** The member a turn may use the own connections of: the one it acts for, in their own private chat only. */
  const turnPerson = (threadId: string, generation?: string): string | null => {
    const member = team ? audienceMember(deps.audienceOf(threadId)) : null;
    return member && actingFor(threadId, generation) === member ? member : null;
  };
  const rosterEntry = (person: string) => deps.roster?.().find((entry) => entry.person === person);
  const nameOf = (person: string): string => deps.personName?.(person) || rosterEntry(person)?.email || people.emailOf(person) || "this person";
  const teamName = () => team?.name ?? "the team";
  /** An admin's page for who connects each app, where one can be connected for the whole team. */
  const appsPage = () => { const where = link(); return where ? `${where}/apps` : null; };
  const noWorkaround = "Nothing was run. Don't try it another way (the browser or another tool).";
  const roleOf = (person: string): TeamRole | null => rosterEntry(person)?.role ?? null;
  const isAdmin = (person: string): boolean => roleOf(person) === "owner" || roleOf(person) === "admin";
  /** Where a person connects their own: an Owner's or Admin's are on the team's Apps page, a User's on their team home. */
  const ownPage = (person: string) => (isAdmin(person) ? appsPage() : link());
  /** Who connects the team's apps, by name: the people a User can ask. */
  const admins = () => list((deps.roster?.() ?? []).filter((entry) => entry.role !== "member").map((entry) => nameOf(entry.person)).slice(0, 3));
  /** How work a person started where others read reaches their own apps: handed on into a chat that is theirs alone. */
  const handOnHow = (who: string) => `To use it, hand that part on: to yourself with start_thread, or to a teammate with coordinate_bots. It runs in that bot's chat with ${who}, with ${who}'s own apps, and only a line saying where the result is comes back here: say only that here.`;

  const lines = {
    connect: (name: string, person: string) => {
      const where = ownPage(person);
      return `${name} is connected by each person in ${teamName()}, and ${nameOf(person)} hasn't connected theirs. ${noWorkaround} Reply with this one line and nothing more about it: `
        + (where ? `"Connect your ${name} here: ${where}"` : `"Connect your own ${name} on your team's page in MausBot Cloud."`);
    },
    /** No one person's own request is behind this work: say so, and how to get it done. */
    nobody: (name: string) => {
      const where = appsPage();
      return `${name} is each person's own in ${teamName()}, and this work doesn't act for one person (a routine, an outside app or a bot started it, or more than one person wrote in it), so no one's ${name} can be used. ${noWorkaround} Reply with this one line and nothing more about it: `
        + `"${name} is each person's own, so I can't use it here. Ask me yourself and I'll use yours${where ? `, or an admin can connect ${name} for the whole team: ${where}` : ""}."`;
    },
    /** The person's own app, asked for where others read: never here, and how it gets done instead. */
    shared: (name: string, who: string) => `${name} is ${who}'s own, and others read this chat, so what it brings back can't come here and it isn't used here. ${noWorkaround} ${handOnHow(who)}`,
    ownOnly: (who: string) => `These are ${who}'s own apps, and this turn no longer acts for ${who}: it was stopped, or someone else wrote in it since. ${noWorkaround} Say so in one plain line: ${who} can ask again.`,
    ownGone: (person: string) => {
      const where = ownPage(person);
      return `${nameOf(person)}'s own apps aren't connected here any more. ${noWorkaround} Reply with this one line and nothing more about it: `
        + (where ? `"Connect your apps again here: ${where}"` : `"Connect your apps again on your team's page in MausBot Cloud."`);
    },
    teamApp: (name: string) => `${name} is ${team?.name ?? "the team"}'s, connected once for everyone: use it through the composio tools, not ${OWN_APPS_SERVER}. Nothing was run.`,
    /** A team app's connection card, asked for through a member's own bridge. An Owner or Admin can connect it for
     * everyone from its card, so the bot asks through the team's bridge; a User is told who can, by name. */
    teamCard: (name: string, person: string) => {
      if (isAdmin(person)) {
        return `${name} is ${teamName()}'s, connected once for everyone, and ${nameOf(person)} can connect it: they're ${roleOf(person) === "owner" ? "the owner" : "an admin"} of ${teamName()}. `
          + `Ask for its connection through the composio tools, not ${OWN_APPS_SERVER}: its card here lets them connect it for the whole team. Nothing was shown.`;
      }
      const who = admins();
      return `${name} is ${teamName()}'s, connected once for everyone by its owner or an admin, and ${nameOf(person)} isn't one. Nothing was shown. Don't try it another way (the browser or another tool). `
        + `Reply with this one line and nothing more about it: "${name} is connected for the whole team by ${who ? who : "the team's owner or an admin"}: ask ${who ? (who.includes(" and ") ? "one of them" : "them") : "one of them"} to connect it."`;
    },
    opaque: (names: string[]) => `Code that calls apps can't run here while ${list(names)} ${names.length === 1 ? "is" : "are"} connected by each person. Call the app's tools directly.`,
  };

  /** What a `person` app the team's bridge was asked for says: in a turn that acts for someone, where theirs is; else no. */
  const personAppLine = (app: string, threadId: string, generation?: string): string => {
    const person = turnPerson(threadId, generation);
    if (person) return people.appsAccess(person) ? `${appLabel(app)} here is ${nameOf(person)}'s own: use it through the ${OWN_APPS_SERVER} tools. Nothing was run.` : lines.connect(appLabel(app), person);
    const acting = actingFor(threadId, generation);
    if (!acting) return lines.nobody(appLabel(app));
    return people.appsAccess(acting) ? lines.shared(appLabel(app), nameOf(acting)) : lines.connect(appLabel(app), acting);
  };
  /** Whether a person connected anything of their own here: an app installation, or a key or sign-in for a server. */
  const hasOwn = (person: string): boolean => {
    if (personApps().length && people.appsAccess(person)) return true;
    return personMcp().some((name) => {
      const server = teamServer(name);
      return Boolean(server && isRemoteMcpServer(server) && (people.key(person, name, server.url) || people.oauth(person).authState(name, server.url) === "signed-in"));
    });
  };

  const personSpec = async (person: string, name: string, spec: Extract<McpServerSpec, { url: string }>): Promise<McpServerSpec | null> => {
    const manager = people.oauth(person);
    if (manager.authState(name, spec.url) === "signed-in") {
      const token = await manager.accessToken(name, spec.url);
      if (token) return { ...spec, headers: { Authorization: `Bearer ${token}` } };
    }
    const key = people.key(person, name, spec.url);
    // The team's own headers never ride along: only this person's.
    return key ? { ...spec, headers: { [key.header]: key.value } } : null;
  };

  return {
    team,
    scopes,
    people,
    personApps,
    personMcp,
    link,
    turnPerson,
    /** The person whose private chat work this turn hands on opens in, so it can use their own connections there: the
     * person the turn acts for, when they connected anything of their own. Null: it opens where it always did. */
    handOnFor(threadId: string, generation: string): string | null {
      const person = actingFor(threadId, generation);
      return person && hasOwn(person) ? person : null;
    },
    /** At start: the team's installation's apps are read now, so the first turn need not wait for them. */
    primeApps(): void {
      if (deps.composio.configured(deps.cfg())) void appsConnected();
    },

    /** The connected-apps bridges of a turn: the team's, and in a turn that acts for a member their own beside it.
     * `names`: how the engine spells the app tools' names. */
    async appsIntegrations(bot: Bot, threadId: string, generation: string, names: "dotted" | "plain" = "plain"): Promise<{ composio?: Integration; composioOwn?: Integration }> {
      const cfg = deps.cfg();
      const out: { composio?: Integration; composioOwn?: Integration } = {};
      const base = { harnessUrl: deps.harnessUrl, botId: bot.id, threadId, connectorTools: bot.connectorTools };
      const shared = await deps.composio.mcpIntegration(cfg, { ...base, commsToken: deps.mint({ botId: bot.id, threadId, generation }) });
      if (shared) out.composio = await withAppTools(shared, bot, names);
      const person = personApps().length ? turnPerson(threadId, generation) : null;
      const access = person ? people.appsAccess(person) : null;
      if (person && access) {
        const own = await deps.composio.mcpIntegration(cfg, { ...base, as: access, commsToken: deps.mint({ botId: bot.id, threadId, generation, connectorsFor: person }) });
        if (own) out.composioOwn = await withAppTools(own, bot, names, access);
      }
      return out;
    },

    /** Whose installation a relayed frame goes to: the team's (none named), or the member's own after checking the turn
     * still acts for them. A refusal is the plain line the bot gets back. */
    relayActor(capability: { threadId: string; generation: string; connectorsFor?: string }): { access?: BrokerAccess; refusal?: string } {
      const own = capability.connectorsFor;
      if (!own) return {};
      if (turnPerson(capability.threadId, capability.generation) !== own) return { refusal: lines.ownOnly(nameOf(own)) };
      const access = people.appsAccess(own);
      return access ? { access } : { refusal: lines.ownGone(own) };
    },

    /** The app calls a frame would run, checked against the scopes: a `person` app never through the team's bridge, a
     * team app never through a member's own. Opaque code is refused on the team's bridge while the team's own
     * installation still holds a connection to a `person` app (it could reach it). */
    async callRefusal(capability: { threadId: string; generation: string; connectorsFor?: string }, calls: ReadonlyArray<{ slug: string }>): Promise<string | null> {
      const apps = personApps();
      if (!team || (!apps.length && !capability.connectorsFor)) return null;
      const own = Boolean(capability.connectorsFor);
      for (const call of calls) {
        if (call.slug === "COMPOSIO_PROXY_EXECUTE") {
          if (own) continue;
          const held = await deps.composio.connectedServiceSlugs(deps.cfg()).catch(() => [] as readonly string[]);
          const kept = apps.filter((slug) => held.includes(slug));
          if (kept.length) return lines.opaque(kept.map(appLabel));
          continue;
        }
        const app = personAppOf(call.slug, apps);
        if (own && !app) return lines.teamApp(appLabel(serviceSlugFor(call.slug) ?? call.slug));
        if (!own && app) return personAppLine(app, capability.threadId, capability.generation);
      }
      return null;
    },

    /** A connection card the bot asked for: never a team card for a `person` app, never any card from a member's bridge
     * (they connect on their team's page): the bot gets the plain line instead. */
    connectRefusal(capability: { threadId: string; generation: string; connectorsFor?: string }, slugs: readonly string[]): string | null {
      if (!team) return null;
      const apps = personApps();
      for (const slug of slugs) {
        const app = apps.includes(slug) ? slug : null;
        if (capability.connectorsFor) return app ? lines.connect(appLabel(app), capability.connectorsFor) : lines.teamCard(appLabel(slug), capability.connectorsFor);
        if (app) {
          const person = turnPerson(capability.threadId, capability.generation) ?? actingFor(capability.threadId, capability.generation);
          return person ? lines.connect(appLabel(app), person) : lines.nobody(appLabel(app));
        }
      }
      return null;
    },

    /** A turn's MCP servers: the team's (never a `person` server's team credential), plus, in a turn that acts for a
     * member, the `person` servers they connected, with their own key or sign-in. What isn't mounted, prompt() says. */
    async turnMcp(bot: McpBot, threadId: string, generation: string): Promise<Record<string, McpServerSpec>> {
      const all = deps.botMcp(bot), names = personMcp();
      const out = await withMcpSignIn(without(all, names), deps.mcpOAuth);
      const person = names.length ? turnPerson(threadId, generation) : null;
      if (!person) return out;
      for (const name of names) {
        const spec = all[name];
        if (!spec || !("url" in spec)) continue;
        const own = await personSpec(person, name, spec);
        if (own) out[name] = own;
      }
      return out;
    },

    /** The bot's servers with no conversation in view (the setup preview, approval keys, chat apps): the team's only. */
    engineMcp(bot: McpBot): Record<string, McpServerSpec> {
      return withoutPendingSignIn(without(deps.botMcp(bot), personMcp()), deps.mcpOAuth);
    },

    /** What the bot is told: in a turn that acts for a member, what is theirs and how to connect what isn't; in one that
     * acts for nobody, why none of these can be used and what the person can do. Empty off a team or with no `person`
     * connection. */
    prompt(threadId: string, generation: string | undefined, mounted: { composioOwn?: unknown; custom?: Record<string, unknown> }): string {
      const apps = personApps(), servers = personMcp();
      if (!team || (!apps.length && !servers.length)) return "";
      const names = [...apps.map(appLabel), ...servers];
      const person = turnPerson(threadId, generation);
      const acting = person ? null : actingFor(threadId, generation);
      if (acting) {
        const who = nameOf(acting);
        const these = `${list(names)} ${names.length === 1 ? "is" : "are"} each person's own in ${team.name}`;
        return hasOwn(acting)
          ? ` ${these}, used only in a chat that is theirs alone. Others read this chat, so ${who}'s own aren't here: what they bring back would be read here. If the task needs one, don't try it another way (the browser or another tool). ${handOnHow(who)}`
          : ` ${these}, and ${who} hasn't connected any yet. If the task needs one, don't try it another way (the browser or another tool): reply with one plain line and nothing more about it: "Connect your <name> here: ${ownPage(acting) ?? "your team's page in MausBot Cloud"}".`;
      }
      if (!person) {
        const where = appsPage();
        return ` ${list(names)} ${names.length === 1 ? "is" : "are"} each person's own in ${team.name}: ${names.length === 1 ? "it works" : "they work"} for the person whose own message started the work, and this work doesn't act for one person (a routine, an outside app or a bot started it, or more than one person wrote in it). `
          + `If the task needs one, don't try it another way (the browser or another tool): reply with one plain line and nothing more about it: "<name> is each person's own, so I can't use it here. Ask me yourself and I'll use yours${where ? `, or an admin can connect <name> for the whole team: ${where}` : ""}."`;
      }
      const who = nameOf(person);
      const whose = `${who}'s`;
      const ownApps = mounted.composioOwn ? apps : [];
      const ownServers = servers.filter((name) => Object.hasOwn(mounted.custom ?? {}, name));
      const missing = [...(mounted.composioOwn ? [] : apps.map(appLabel)), ...servers.filter((name) => !ownServers.includes(name))];
      const where = ownPage(person);
      const only = `They are used only for ${who}'s request: if someone else asks for something from them, say they are ${whose}.`;
      return (ownApps.length ? ` ${list(ownApps.map(appLabel))} ${ownApps.length === 1 ? "is" : "are"} ${whose} own: use ${ownApps.length === 1 ? "it" : "them"} through the ${OWN_APPS_SERVER} tools, which act as their own accounts; ${team.name}'s shared apps stay under composio.` : "")
        + (ownServers.length ? ` The MCP ${ownServers.length === 1 ? "server" : "servers"} ${list(ownServers)} act${ownServers.length === 1 ? "s" : ""} as ${whose} own account.` : "")
        + (ownApps.length || ownServers.length ? ` ${only}` : "")
        + (missing.length ? ` Each person connects these for themselves, and ${who} hasn't connected ${missing.length === 1 ? "it" : "them"} yet, or their sign-in ended: ${list(missing)}. If the task needs one, don't try it another way (the browser or another tool): reply with one plain line and nothing more about it: "Connect your <name> here: ${where ?? "your team's page in MausBot Cloud"}".` : "");
    },

    /** Whose own account a tool call uses, for its step ("using Ada's Notion"): a `person` app through their own bridge,
     * or a `person` MCP server, in a turn that acts for them. Empty for anything else. */
    toolWhose(threadId: string, generation: string | undefined, tool: string, input?: unknown): { whose?: { person: string; app: string } } {
      const apps = personApps(), servers = personMcp();
      if (!team || !generation || (!apps.length && !servers.length)) return {};
      const named = /^mcp__(.+?)__(.+)$/.exec(tool);
      const server = named?.[1], bare = named?.[2] ?? tool;
      let app: string | null = null, theirs: (person: string) => boolean = () => false;
      if (server !== undefined && servers.includes(server)) {
        const spec = teamServer(server);
        const url = spec && isRemoteMcpServer(spec) ? spec.url : null;
        app = server;
        theirs = (person) => Boolean(url && (people.key(person, server, url) || people.oauth(person).authState(server, url) === "signed-in"));
      } else if (server === undefined || server === OWN_APPS_SERVER) {
        // A meta-tool names the app tools it runs in its input; an app tool names its app first.
        const called = typeof input === "string" ? input : input === undefined ? "" : JSON.stringify(input);
        const slugs = [bare.replace(/\./g, "_"), ...[...called.matchAll(/"tool_slug"\s*:\s*"([A-Za-z0-9_]+)"/g)].map((match) => match[1]!)];
        const slug = slugs.map((candidate) => personAppOf(candidate, apps)).find(Boolean);
        app = slug ? appLabel(slug) : null;
        theirs = (person) => people.appsAccess(person) !== null;
      }
      const person = app ? turnPerson(threadId, generation) : null;
      return app && person && theirs(person) ? { whose: { person: nameOf(person), app } } : {};
    },

    /** An MCP server was removed: every person's key and sign-in for it go, and it is the team's again if re-added. */
    forgetServer(name: string): void {
      people.forgetServer(name);
      if (scopes.scope("mcp", name) === "person") scopes.set("mcp", name, "team");
    },

    /** The public MCP sign-in callback: the team's flows first, then each member's own. */
    async mcpCallback(host: string | undefined, search: string): Promise<{ status: number; text: string }> {
      const shared = await deps.mcpOAuth.publicCallback(host, search);
      if (shared.status !== 400) return shared;
      for (const manager of people.liveManagers()) {
        const answer = await manager.publicCallback(host, search);
        if (answer.status !== 400) return answer;
      }
      return shared;
    },

    /** A person who left the team (host/team-member-left.ts): every connection, key and sign-in of theirs goes. */
    forgetPerson: (person: string) => people.forgetPerson(person),
    /** For the Admin's signed read: what is `person`, and who has connected each (addresses, never a secret). */
    async adminExtras(): Promise<{ scopes: { apps: string[]; mcp: string[] }; people: { apps: Record<string, string[]>; mcp: Record<string, string[]> } } | Record<string, never>> {
      if (!team) return {};
      const apps = personApps(), servers = personMcp();
      const byApp: Record<string, string[]> = Object.fromEntries(apps.map((slug) => [slug, [] as string[]]));
      if (apps.length) {
        await Promise.all(people.appsPeople().map(async ({ email, access }) => {
          const connected = await deps.composio.connectedServices(deps.cfg(), access).catch(() => null);
          for (const slug of apps) if (connected?.[slug]?.connected) byApp[slug]!.push(email);
        }));
      }
      const byServer: Record<string, string[]> = {};
      for (const name of servers) {
        const server = teamServer(name);
        const url = server && isRemoteMcpServer(server) ? server.url : null;
        const who = url ? [...people.keyPeople(name, url), ...people.signedInPeople(name, url)] : [];
        byServer[name] = [...new Set(who.map((entry) => entry.email).filter(Boolean))].sort();
      }
      for (const slug of apps) byApp[slug]!.sort();
      return { scopes: { apps, mcp: servers }, people: { apps: byApp, mcp: byServer } };
    },
  };
}

export type TeamConnectionsHost = ReturnType<typeof createTeamConnectionsHost>;
