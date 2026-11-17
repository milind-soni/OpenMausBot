// Feeds connection-health.ts from real use and answers what the Admin's signed read adds about each connection.
// Everywhere: an MCP server that refuses a sign-in's token on a real call gets it refreshed at once, or the sign-in is
// marked ended, so "signed in" stays true. On a Team Cloud also: each connection's health, who added it, the bots that
// use it, and each member's own state for a connection each person connects.
// Privacy (docs/team-cloud.md "private means private"): a member's own state says only whether they connected what an
// admin asked everyone to connect: never when or how they used it, nor anything about a connection nobody asked for.
import { join } from "node:path";

import { type ConnectionHealthWord, type ConnectionStatus, type PersonConnectionState, type TeamAdminSummary } from "../cloud-team-admin.ts";
import type { ConnectorServiceState } from "../composio.ts";
import { STALE_MS, createBackgroundCheck } from "../connection-health-check.ts";
import { CONNECTION_HEALTH_FILE, accountHealth, createConnectionHealth, type ConnectionHealthView, type ConnectionOutcome, type ConnectionRef } from "../connection-health.ts";
import { MCP_FAILURE_CLASS, appCallOutcome, forbidsRatherThanSignsOut, probeOutcome } from "../connection-outcome.ts";
import { serviceSlugFor } from "../connector-verdict.ts";
import { mcpFailureKind, mcpServerOfTool } from "../mcp-failure.ts";
import type { McpOAuthManager, McpRefreshOutcome } from "../mcp-oauth.ts";
import type { McpProbeResult } from "../mcp-probe.ts";
import { isRemoteMcpServer, parseStoredMcpServer } from "../mcp-registry.ts";
import { personAppOf } from "../team-connections.ts";
import type { McpConfigResult } from "./mcp-config.ts";
import type { TeamConnectionsHost } from "./team-connections-host.ts";

type Bot = {
  name: string; hidden?: boolean; movedTo?: unknown; defaultBot?: { person?: string };
  composio?: boolean; connectorTools?: Record<string, unknown>; connectorScopes?: { apps: Record<string, unknown> };
};
type OAuth = Pick<McpOAuthManager, "authState" | "tokenRefused" | "endsAt">;

export interface ConnectionHealthHostDeps<B extends Bot = Bot> {
  /** Where health is kept: a Team Cloud's data folder. Null elsewhere, where only the sign-in check runs. */
  dataDir: string | null;
  mcpServers(): Record<string, unknown>;
  mcpOAuth: OAuth;
  connections: Pick<TeamConnectionsHost, "personMcp" | "personApps" | "turnPerson" | "ownAppsServices"> & {
    people: { oauth(person: string): OAuth; key(person: string, name: string, url: string): unknown; appsAccess(person: string): unknown };
  };
  bots(): readonly B[];
  /** The MCP servers a bot's turns start, by name. */
  botServers(bot: B): readonly string[];
  /** The members the Admin paired here (team-people.json). */
  roster(): ReadonlyArray<{ email: string }>;
  personKey(email: string): string;
  /** The name a member goes by on the team, if they set one. */
  personName(email: string): string | null;
  /** Test for the team's server, as the app's Test runs it. */
  test?(name: string, signal: AbortSignal): Promise<McpConfigResult>;
  asleep(): boolean;
  wokeAt(): number | null;
  now?(): number;
}

const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());
/** A connection whose app's account stays gone this long after it was added is taken for removed. */
const ADD_PENDING_MS = 60 * 60_000;

export function createConnectionHealthHost<B extends Bot>(deps: ConnectionHealthHostDeps<B>) {
  const store = deps.dataDir === null ? null : createConnectionHealth({ file: join(deps.dataDir, CONNECTION_HEALTH_FILE), ...(deps.now ? { now: deps.now } : {}) });
  const now = deps.now ?? Date.now;
  const remote = (name: string) => {
    const raw = deps.mcpServers()[name];
    const parsed = raw === undefined ? null : parseStoredMcpServer(name, raw);
    return parsed?.ok && isRemoteMcpServer(parsed.server) ? parsed.server : null;
  };
  const remoteUrl = (name: string): string | null => remote(name)?.url ?? null;
  const oauthOf = (person: string | undefined) => (person ? deps.connections.people.oauth(person) : deps.mcpOAuth);

  /** A server refused credentials: a sign-in's token is renewed or found ended; a key it was sent is refused. */
  const refusedCredentials = async (ref: ConnectionRef, error: "sign-in" | "refused", firstLine: string): Promise<ConnectionOutcome | null> => {
    const server = remote(ref.id);
    if (!server) return { ok: false, error };
    const oauth = oauthOf(ref.person);
    if (oauth.authState(ref.id, server.url) !== "signed-in" || forbidsRatherThanSignsOut(firstLine)) {
      const sentKey = ref.person ? deps.connections.people.key(ref.person, ref.id, server.url) !== null : Object.keys(server.headers).length > 0;
      return { ok: false, error: sentKey ? "refused" : error };
    }
    const refusal = await oauth.tokenRefused(ref.id, server.url);
    return refusal === "ended" ? { ok: false, error: "sign-in" } : refusal === "again" ? { ok: false, error: "refused" } : null;
  };

  const checkTeamServer = async (name: string, result: McpProbeResult): Promise<ConnectionOutcome | null> => {
    const outcome = probeOutcome(result);
    if (outcome.ok || outcome.error !== "refused") return outcome;
    return refusedCredentials({ kind: "mcp", id: name }, "refused", result.ok ? "" : `HTTP ${result.status ?? ""}`);
  };

  const background = store && deps.test ? createBackgroundCheck<string, ConnectionOutcome>({
    due: () => {
      const personal = deps.connections.personMcp();
      return Object.keys(deps.mcpServers()).flatMap((name) => {
        const raw = deps.mcpServers()[name];
        const parsed = parseStoredMcpServer(name, raw);
        if (!parsed.ok || !isRemoteMcpServer(parsed.server) || !parsed.server.enabled || parsed.server.runsOn || personal.includes(name)) return [];
        if (deps.mcpOAuth.authState(name, parsed.server.url) === "needs-sign-in") return [];
        const view = store.get({ kind: "mcp", id: name });
        const last = Math.max(view.lastUsedAt ?? 0, view.checkedAt ?? 0);
        return now() - last >= STALE_MS ? [{ name, last }] : [];
      }).sort((a, b) => a.last - b.last).map((entry) => entry.name);
    },
    check: async (name, signal) => {
      const result = await deps.test!(name, signal);
      return "body" in result ? checkTeamServer(name, result.body as McpProbeResult) : null;
    },
    record: (name, outcome) => { store.observe({ kind: "mcp", id: name }, outcome); },
    asleep: deps.asleep,
    wokeAt: deps.wokeAt,
    now,
  }) : null;

  const teamBots = () => deps.bots().filter((bot) => !bot.hidden && !bot.movedTo && !bot.defaultBot?.person);
  const usesApp = (bot: B, slug: string) => bot.composio !== false
    && (!bot.connectorScopes || Object.hasOwn(bot.connectorScopes.apps, slug))
    && (bot.connectorTools === undefined || Object.hasOwn(bot.connectorTools, slug));

  const status = (view: ConnectionHealthView): ConnectionStatus => ({
    ...(view.health ? { health: view.health, checkedAt: iso(view.checkedAt) } : {}),
    ...(view.lastError ? { lastError: view.lastError } : {}),
    ...(view.lastUsedAt ? { lastUsedAt: iso(view.lastUsedAt) } : {}),
  });
  const provenance = (kind: "app" | "mcp", id: string): Pick<ConnectionStatus, "addedBy" | "addedAt"> => {
    const added = store?.addedBy(kind, id);
    return added ? { addedBy: { email: added.email, name: deps.personName(added.email) }, addedAt: iso(added.at) } : {};
  };
  /** The team's MCP server's health, with what its stored sign-in says now. */
  const mcpView = (name: string, signedIn: boolean | null, endsAt: number | null): ConnectionHealthView => {
    const view = store?.get({ kind: "mcp", id: name }) ?? {};
    if (endsAt !== null && endsAt <= now()) return { ...view, health: "needs-sign-in", checkedAt: endsAt, lastError: "expired" };
    if (signedIn === false && view.health !== "needs-sign-in" && view.health !== "refused") return { ...view, health: "needs-sign-in", checkedAt: now(), lastError: "sign-in" };
    return view;
  };
  /** The team's app's health: its accounts' own word when that says it is not working, else what real use showed. */
  const appView = (slug: string, accounts: ReadonlyArray<{ status: string }>): ConnectionHealthView => {
    const view = store?.get({ kind: "app", id: slug }) ?? {};
    const words = accounts.map((account) => accountHealth(account.status)).filter((word) => word !== null);
    if (words.some((word) => word.health === "working")) return view.health ? view : { ...view, health: "working", checkedAt: now() };
    const first = words[0];
    return first ? { ...view, health: first.health, checkedAt: now(), ...(first.error ? { lastError: first.error } : {}) } : view;
  };
  const ownState = (ref: ConnectionRef, connected: boolean, signedOut: boolean): PersonConnectionState => {
    const health = store?.get(ref).health;
    if (connected) return health === "needs-sign-in" || health === "refused" ? "needs-sign-in" : "connected";
    return signedOut ? "needs-sign-in" : "not-connected";
  };

  /** Every member's own state for each connection each person connects, by address: only those, never another of theirs. */
  const personStates = async (scopes: { apps: readonly string[]; mcp: readonly string[] }, members: ReadonlyArray<{ email: string }>) => {
    const out: NonNullable<NonNullable<TeamAdminSummary["people"]>["states"]> = { apps: {}, mcp: {} };
    for (const name of scopes.mcp) {
      const url = remoteUrl(name);
      out.mcp[name] = Object.fromEntries(members.map(({ email }) => {
        const person = deps.personKey(email);
        const signIn = url ? deps.connections.people.oauth(person).authState(name, url) : "none";
        const key = url ? deps.connections.people.key(person, name, url) !== null : false;
        return [email, ownState({ kind: "mcp", id: name, person }, signIn === "signed-in" || key, signIn === "needs-sign-in")];
      }));
    }
    if (scopes.apps.length) {
      const reads = new Map((await deps.connections.ownAppsServices()).map((read) => [read.person, read.services]));
      for (const slug of scopes.apps) {
        out.apps[slug] = Object.fromEntries(members.flatMap(({ email }) => {
          const person = deps.personKey(email);
          if (!reads.has(person)) return [[email, "not-connected" as const]];
          const services: Record<string, ConnectorServiceState> | null = reads.get(person) ?? null;
          if (!services) return [];
          const service = services[slug];
          return [[email, ownState({ kind: "app", id: slug, person }, Boolean(service?.connected), Boolean(service && !service.connected && service.accounts.length))]];
        }));
      }
    }
    return out;
  };

  return {
    /** A finished tool step: when it was an MCP server's, what it showed about that server. */
    async toolStep(step: { threadId: string; generation?: string; tool: string; ok?: boolean; output?: string }): Promise<void> {
      if (step.ok === undefined) return;
      const name = mcpServerOfTool(step.tool, Object.keys(deps.mcpServers()));
      if (!name) return;
      const personal = deps.connections.personMcp().includes(name);
      const person = personal ? deps.connections.turnPerson(step.threadId, step.generation) : null;
      if (personal && !person) return;
      const ref: ConnectionRef = { kind: "mcp", id: name, ...(person ? { person } : {}) };
      const kind = step.ok === false && step.output ? mcpFailureKind(step.output) : null;
      if (step.ok === false && !step.output) return store?.used(ref);
      if (!kind) return void store?.observe(ref, { ok: true }, { use: true });
      const error = MCP_FAILURE_CLASS[kind];
      const outcome = error === "sign-in" || error === "refused" ? await refusedCredentials(ref, error, step.output!) : { ok: false as const, error };
      if (outcome) store?.observe(ref, outcome, { use: true });
      else store?.used(ref);
    },

    /** A connected-apps call through the relay, the team's installation or (`person`) a member's own. */
    appCall(call: { person?: string; slugs: readonly string[]; status: number; bytes: Uint8Array; contentType: string }): void {
      if (!store) return;
      const personApps = deps.connections.personApps();
      const apps = [...new Set(call.slugs.map((slug) => (call.person ? personAppOf(slug, personApps) : null) ?? serviceSlugFor(slug)).filter((app): app is string => Boolean(app)))];
      if (!apps.length) return;
      const outcome = appCallOutcome(call.status, call.bytes, call.contentType);
      for (const app of apps) {
        const ref: ConnectionRef = { kind: "app", id: app, ...(call.person ? { person: call.person } : {}) };
        if (!outcome || (!outcome.ok && apps.length > 1)) { store.used(ref); continue; }
        store.observe(ref, outcome, { use: true });
      }
    },

    /** How a refresh of the team's (`person` null) or a member's own sign-in ended. */
    refreshed(person: string | null, name: string, outcome: McpRefreshOutcome): void {
      if (outcome !== "rejected" && outcome !== "expired") return;
      store?.observe({ kind: "mcp", id: name, ...(person ? { person } : {}) }, { ok: false, error: outcome === "rejected" ? "refresh-rejected" : "expired" });
    },

    /** Test on the team's server, pressed by an admin. */
    async tested(name: string, result: McpProbeResult): Promise<void> {
      if (!store || deps.connections.personMcp().includes(name)) return;
      const outcome = await checkTeamServer(name, result);
      if (outcome) store.observe({ kind: "mcp", id: name }, outcome);
    },

    /** An admin added the team's MCP server or started connecting an app (`email`: who, when known). */
    added(kind: "app" | "mcp", id: string, email: string | null): void {
      if (!store) return;
      if (kind === "mcp") store.forget("mcp", id);
      else store.reset({ kind, id });
      if (email && (kind === "mcp" || !store.addedBy(kind, id))) store.added(kind, id, email);
    },
    removed(kind: "app" | "mcp", id: string): void { store?.forget(kind, id); },
    /** The team's sign-in to a server succeeded, or a member connected their own again. */
    connectedAgain(ref: ConnectionRef): void { store?.reset(ref); },
    forgetPerson(person: string): void { store?.forgetPerson(person); },

    /** The Admin's signed read, with each connection's health, origin, bots and use, and each member's own states. Drops
     * what it kept about connections that are gone. */
    async adminRead(summary: TeamAdminSummary): Promise<TeamAdminSummary> {
      if (!store) return summary;
      const configured = deps.mcpServers();
      for (const id of store.known("mcp")) if (!Object.hasOwn(configured, id)) store.forget("mcp", id);
      const scopes = summary.scopes ?? { apps: [], mcp: [] };
      if (summary.apps.available) {
        const listed = new Set(summary.apps.services.map((service) => service.slug));
        for (const id of store.known("app")) {
          const added = store.addedBy("app", id);
          if (!listed.has(id) && !scopes.apps.includes(id) && (!added || now() - added.at >= ADD_PENDING_MS)) store.forget("app", id);
        }
      }
      const bots = teamBots();
      const servers = new Map(bots.map((bot) => [bot, deps.botServers(bot)]));
      const members = deps.roster();
      return {
        ...summary,
        apps: {
          ...summary.apps,
          services: summary.apps.services.map((service) => {
            const shared = !scopes.apps.includes(service.slug);
            return {
              ...service,
              accounts: service.accounts.map((account) => {
                const word = accountHealth(account.status);
                return word ? { ...account, health: word.health as ConnectionHealthWord } : account;
              }),
              ...(shared ? status(appView(service.slug, service.accounts)) : {}),
              ...provenance("app", service.slug),
              bots: bots.filter((bot) => usesApp(bot, service.slug)).map((bot) => bot.name),
            };
          }),
        },
        mcp: summary.mcp.map((server) => {
          const shared = !scopes.mcp.includes(server.name);
          const url = remoteUrl(server.name);
          const endsAt = shared && url ? deps.mcpOAuth.endsAt(server.name, url) : null;
          return {
            ...server,
            ...(endsAt !== null ? { expiresAt: iso(endsAt) } : {}),
            ...(shared ? status(mcpView(server.name, server.signedIn, endsAt)) : {}),
            ...provenance("mcp", server.name),
            bots: bots.filter((bot) => servers.get(bot)!.includes(server.name)).map((bot) => bot.name),
          };
        }),
        ...(summary.people ? {
          people: { ...summary.people, states: await personStates(scopes, members) },
        } : {}),
      };
    },

    start(): void { background?.start(); },
    stop(): void { background?.stop(); store?.flush(); },
    /** Tests: one background check now. */
    checkNow: () => background?.tick() ?? Promise.resolve(null),
  };
}

export type ConnectionHealthHost = ReturnType<typeof createConnectionHealthHost>;
