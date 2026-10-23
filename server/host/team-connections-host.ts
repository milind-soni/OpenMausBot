// Whose connection a turn on a Team Cloud may use. The team's connections serve every turn; a `person` app or MCP server
// is offered to a turn only when the turn is that member's own: its conversation is their private chat (`member:<person>`)
// and their own message started it.
// Security: nothing else ever gets a member's connection: not a group chat, the bot's main chat, another member's chat,
// an admin writing in theirs, a routine or a webhook. The relay checks it again on every call. Off a team nothing changes.
import { join } from "node:path";

import { audienceMember, type Audience } from "../audience.ts";
import type { CloudTeam } from "../cloud-team.ts";
import type * as Composio from "../composio.ts";
import type { AppConfig } from "../config.ts";
import type { McpServerSpec } from "../contracts.ts";
import { serviceSlugFor } from "../connector-verdict.ts";
import { type McpOAuthManager, withMcpSignIn, withoutPendingSignIn } from "../mcp-oauth.ts";
import { isRemoteMcpServer, parseStoredMcpServer } from "../mcp-registry.ts";
import { OWN_APPS_SERVER } from "../../shared/own-apps.ts";
import { appLabel, ConnectionScopes, PeopleConnections, personAppOf, SCOPES_FILE, type BrokerAccess } from "../team-connections.ts";

type Bot = { id: string; name: string; connectorTools?: Parameters<typeof Composio.mcpIntegration>[1]["connectorTools"] };
type Integration = { command: string; args: string[]; env: Record<string, string> };

export interface TeamConnectionsHostDeps {
  team: CloudTeam | null;
  dataDir: string;
  cfg: () => AppConfig;
  /** The Admin's origin (OMB_CLOUD_ADMIN_URL): a member connects their own on their team's page there. */
  adminOrigin: string | null;
  harnessUrl: string;
  audienceOf(threadId: string): Audience;
  /** The person whose own message provably started this turn generation (the latest one when none is named), or null. */
  requester(threadId: string, generation?: string): string | null;
  /** A `connectors` capability for this turn; `connectorsFor` makes it the member's own bridge's. */
  mint(capability: { botId: string; threadId: string; generation: string; roomHandoffId?: string; connectorsFor?: string }): string;
  mcpOAuth: McpOAuthManager;
  /** The bot's enabled MCP servers, as policy allows them, before any sign-in is attached. */
  botMcp(bot: { mcpServers?: string[] }): Record<string, McpServerSpec>;
  isSessionLive(id: string): boolean;
  /** The connected-apps service a member's own installation is made on; null: none here. */
  brokerUrl(): string | null;
  composio: Pick<typeof Composio, "configured" | "mcpIntegration" | "connectedServices" | "connectedServiceSlugs" | "authorizeService" | "removeService">;
}

const list = (names: readonly string[]) => names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

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
  const personMcp = () => (team ? scopes.person("mcp") : []);
  const link = () => (team && deps.adminOrigin ? `${deps.adminOrigin}/cloud/team/${encodeURIComponent(team.id)}` : null);
  const without = <T,>(servers: Record<string, T>, names: readonly string[]) =>
    Object.fromEntries(Object.entries(servers).filter(([name]) => !names.includes(name)));

  /** The member a turn may act for: their private chat, started by their own message. */
  const turnPerson = (threadId: string, generation?: string): string | null => {
    if (!team) return null;
    const person = audienceMember(deps.audienceOf(threadId));
    return person && deps.requester(threadId, generation) === person ? person : null;
  };

  const lines = {
    connect: (name: string) => {
      const where = link();
      return `${name} is connected by each person in ${team?.name ?? "the team"}, and this person hasn't connected theirs. Reply with this one line and nothing more about it: `
        + (where ? `"Connect your ${name} here: ${where}"` : `"Connect your own ${name} on your team's page in MausBot Cloud."`);
    },
    elsewhere: (name: string) => `${name} is connected by each person in ${team?.name ?? "the team"} and works only in that person's own private chat with this bot, `
      + "for their own requests. It can't be used here: say so in one plain line. Nothing was run.",
    ownOnly: "These are one person's own apps: they work only in that person's private chat, for their own requests. Nothing was run.",
    teamApp: (name: string) => `${name} is ${team?.name ?? "the team"}'s, connected once for everyone: use it through the composio tools, not ${OWN_APPS_SERVER}. Nothing was run.`,
    teamCard: (name: string) => `${name} is ${team?.name ?? "the team"}'s, connected once for everyone by an admin: ask an admin to connect it. Nothing was shown.`,
    opaque: (names: string[]) => `Code that calls apps can't run here while ${list(names)} ${names.length === 1 ? "is" : "are"} connected by each person. Call the app's tools directly.`,
  };

  /** What a `person` app the team's bridge was asked for says: in the member's own turn, where theirs is; elsewhere, no. */
  const personAppLine = (app: string, threadId: string, generation?: string): string => {
    const person = turnPerson(threadId, generation);
    if (!person) return lines.elsewhere(appLabel(app));
    return people.appsAccess(person) ? `${appLabel(app)} here is this person's own: use it through the ${OWN_APPS_SERVER} tools. Nothing was run.` : lines.connect(appLabel(app));
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

    /** The connected-apps bridges of a turn: the team's, and in a member's own turn their own beside it. */
    async appsIntegrations(bot: Bot, threadId: string, generation: string, roomHandoffId?: string): Promise<{ composio?: Integration; composioOwn?: Integration }> {
      const cfg = deps.cfg();
      const out: { composio?: Integration; composioOwn?: Integration } = {};
      const base = { harnessUrl: deps.harnessUrl, botId: bot.id, threadId, connectorTools: bot.connectorTools };
      const shared = await deps.composio.mcpIntegration(cfg, { ...base, commsToken: deps.mint({ botId: bot.id, threadId, generation, ...(roomHandoffId ? { roomHandoffId } : {}) }) });
      if (shared) out.composio = shared;
      const person = personApps().length ? turnPerson(threadId, generation) : null;
      const access = person ? people.appsAccess(person) : null;
      if (person && access) {
        const own = await deps.composio.mcpIntegration(cfg, { ...base, as: access, commsToken: deps.mint({ botId: bot.id, threadId, generation, ...(roomHandoffId ? { roomHandoffId } : {}), connectorsFor: person }) });
        if (own) out.composioOwn = own;
      }
      return out;
    },

    /** Whose installation a relayed frame goes to: the team's (none named), or the member's own after checking the turn
     * is still theirs. A refusal is the plain line the bot gets back. */
    relayActor(capability: { threadId: string; generation: string; connectorsFor?: string }): { access?: BrokerAccess; refusal?: string } {
      if (!capability.connectorsFor) return {};
      if (turnPerson(capability.threadId, capability.generation) !== capability.connectorsFor) return { refusal: lines.ownOnly };
      const access = people.appsAccess(capability.connectorsFor);
      return access ? { access } : { refusal: lines.ownOnly };
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
        if (capability.connectorsFor) return app ? lines.connect(appLabel(app)) : lines.teamCard(appLabel(slug));
        if (app) return turnPerson(capability.threadId, capability.generation) ? lines.connect(appLabel(app)) : lines.elsewhere(appLabel(app));
      }
      return null;
    },

    /** A turn's MCP servers: the team's (never a `person` server's team credential), plus, in a member's own turn, the
     * `person` servers they connected, with their own key or sign-in. */
    async turnMcp(bot: { mcpServers?: string[] }, threadId: string, generation: string): Promise<Record<string, McpServerSpec>> {
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
    engineMcp(bot: { mcpServers?: string[] }): Record<string, McpServerSpec> {
      return withoutPendingSignIn(without(deps.botMcp(bot), personMcp()), deps.mcpOAuth);
    },

    /** What the bot is told: in a member's own turn, what is theirs and how to connect what isn't; elsewhere, that these
     * work only in each person's private chat. Empty off a team or with no `person` connection. */
    prompt(threadId: string, mounted: { composioOwn?: unknown; custom?: Record<string, unknown> }): string {
      const apps = personApps(), servers = personMcp();
      if (!team || (!apps.length && !servers.length)) return "";
      const names = [...apps.map(appLabel), ...servers];
      const person = turnPerson(threadId);
      if (!person) {
        return ` ${list(names)} ${names.length === 1 ? "is" : "are"} connected by each person in ${team.name} and work only in that person's own private chat with you, `
          + "for their own requests. If asked to use one here, say in one plain line that it works only in each person's private chat.";
      }
      const who = people.emailOf(person) ?? "this person";
      const whose = who === "this person" ? "this person's" : `${who}'s`;
      const ownApps = mounted.composioOwn ? apps : [];
      const ownServers = servers.filter((name) => Object.hasOwn(mounted.custom ?? {}, name));
      const missing = [...(mounted.composioOwn ? [] : apps.map(appLabel)), ...servers.filter((name) => !ownServers.includes(name))];
      const where = link();
      return (ownApps.length ? ` ${list(ownApps.map(appLabel))} ${ownApps.length === 1 ? "is" : "are"} ${whose} own: use ${ownApps.length === 1 ? "it" : "them"} through the ${OWN_APPS_SERVER} tools, which act as their own accounts; ${team.name}'s shared apps stay under composio.` : "")
        + (ownServers.length ? ` The MCP ${ownServers.length === 1 ? "server" : "servers"} ${list(ownServers)} act${ownServers.length === 1 ? "s" : ""} as ${whose} own account.` : "")
        + (missing.length ? ` Each person connects these for themselves, and this person hasn't yet: ${list(missing)}. If the task needs one, reply with one plain line and nothing more about it: "Connect your <name> here: ${where ?? "your team's page in MausBot Cloud"}".` : "");
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
