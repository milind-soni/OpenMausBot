import { userError, type UserError } from "../user-errors.ts";
import { withMcpSignIn, type McpOAuthManager } from "../mcp-oauth.ts";
import { brokeredServer, type BrokerPath } from "../bot-box/broker-probe.ts";
import { probeMcpServer, sendsCredentials, type McpProbeOptions, type McpProbeResult } from "../mcp-probe.ts";
import { isRemoteMcpServer, mcpServerLimitError, mcpServerNotFound, parseStoredMcpServer, type McpRunsOn, type StoredMcpServer, type StoredRemoteMcpServer } from "../mcp-registry.ts";
import { postizKeyHeaders } from "../postiz/connection.ts";
import type { AppConfig } from "../config.ts";
import type { ChatAppsMcp } from "../chat-apps-mcp.ts";
import type { CloudHomeConfig } from "../cloud-home.ts";
import type { BusyFlag } from "../routes/config.ts";
import type { SessionRegistry } from "../sessions.ts";
import type { McpKeys } from "../vault/mcp-keys.ts";
import type { TeamConnectionsHost } from "./team-connections-host.ts";

export interface McpConfigDeps {
  cfg: Pick<AppConfig, "mcpServers" | "postiz">;
  sessions: Pick<SessionRegistry, "isLive">;
  mcpOAuth: McpOAuthManager;
  teamConnections: Pick<TeamConnectionsHost, "personMcp" | "people">;
  cloudHome: Pick<CloudHomeConfig, "publicOrigin"> | null;
  fallbackPublicUrl: string | null;
  mcpConfigBusy: BusyFlag;
  /** Secrets as booleans, sign-in state attached. */
  mcpServerResponse(): Record<string, unknown>;
  mcpPolicyRefusal(name: string, server: object): string | undefined;
  persistMcpServers(next: Record<string, unknown>): void;
  savedCustomDomain(): string | null;
  appCatalog?: Pick<ChatAppsMcp, "probeOptions" | "serverChanged" | "forgetServer"> & Partial<Pick<ChatAppsMcp, "hasApps">>;
  /** A Team Cloud: each member's own key and sign-in for a removed server go with it. */
  forgetPeople?(name: string): void;
  /** Whether each command server starts for each bot: checked again when one is added, changed, turned on or restarted. */
  health?: { changed(name: string): void };
  /** A server was added or removed on purpose: a Cloud home's routines wait while every connection is gone. */
  connectionsChanged?(change: "added" | "removed"): void;
  /** How bots' turns reach a URL server here: through the broker where turns are boxed (null: directly). */
  botsPath?(): BrokerPath | null;
  /** How Test starts a command server when no bot asks: as the turns of its bot, or of any bot (server/mcp-probe.ts `asBot`). */
  probeAs?(server: { bot?: string }): NonNullable<McpProbeOptions["asBot"]>;
  /** Test for a server that runs on another computer: on that computer, through lending, for whoever tests (`lender`). */
  testElsewhere?(name: string, server: StoredMcpServer & { runsOn: McpRunsOn }, lender: string | null, signal: AbortSignal): Promise<McpConfigResult>;
  /** A server's `vault:<id>` keys, read when it is tested and given only to the server a move or a redeemed ref names. */
  keys?: McpKeys;
}

export type McpConfigRefusal = { status: number; error: string; code?: string } & Partial<Pick<UserError, "errorKey" | "errorParams">>;
export type McpConfigResult = { status: number; body: Record<string, unknown> } | McpConfigRefusal;

export interface McpConfig {
  /** `keys`: the Vault items this server may read its `vault:<id>` keys from, when a move carries it (else a redeemed ref grants them). */
  add(name: string, server: StoredMcpServer, keys?: readonly string[]): McpConfigResult;
  replace(name: string, server: StoredMcpServer, keys?: readonly string[]): McpConfigResult;
  /** Several servers at once, all or none; they arrive disabled. `read` runs with the flag held, so another writer is
   * refused for the whole request, its body included. */
  addMany(read: () => Promise<{ servers: Record<string, StoredMcpServer> } | McpConfigRefusal>): Promise<McpConfigResult>;
  setEnabled(name: string, enabled: boolean): McpConfigResult;
  /** The next turn of every bot that uses it starts a new process, with what is saved today: keys, sign-in and all. */
  restart(name: string): McpConfigResult;
  setApps(name: string, apps: boolean): McpConfigResult;
  remove(name: string): McpConfigResult;
  /** A 200 carries the probe result as its body, failures included: only a refusal to probe is an error. */
  test(name: string, options: {
    asBot?: { id: string; cwd: string };
    signal: AbortSignal;
    /** A person's own connection, asked for only when the server is theirs; null when there is no one to answer for it. */
    person?: (url: string) => { oauth: McpOAuthManager; key?: { header: string; value: string } } | null;
    /** Whose lent computers a server that runs elsewhere is tested on; null or absent: nobody's. */
    lender?: string | null;
  }): Promise<McpConfigResult>;
  /** The one flag every writer of `cfg.mcpServers` takes: two writers must not interleave a read with a save. */
  busy: BusyFlag;
}

/** Where turns are boxed, a URL server is tested the way bots reach it: through the broker. If that fails but the server
 * answers directly, the fault is ours, never the person's settings, and the test says so instead of "Connected". */
async function probeAsBots(path: BrokerPath, name: string, target: StoredRemoteMcpServer, signal: AbortSignal, options: McpProbeOptions): Promise<McpProbeResult> {
  const brokered = brokeredServer(path, name, target);
  let result: McpProbeResult;
  try {
    result = await probeMcpServer(target, undefined, signal, { ...options, via: { url: brokered.url, fetch: brokered.fetch } });
  } finally {
    await brokered.done();
  }
  if (result.ok || result.auth === "required" || signal.aborted) return result;
  const direct = await probeMcpServer(target, undefined, signal);
  return direct.ok
    ? { ok: false, reason: "unreachable", error: `Your bots can't reach this server: ${result.error.replace(/ Check [^.]*\.$/, "")} It answers when tested directly, so the fault is on our side, not in your settings: tell us with @devs in any chat.` }
    : result;
}

/** A server of another computer's: its program, files or address are there, so it is never started or signed in to here. */
export const runsElsewhere = (runsOn: McpRunsOn) => `This server runs on ${runsOn.label}, so it isn't started here.`;

const personalHeaderValueRefusal = (personal: string[], name: string, server: StoredMcpServer) =>
  personal.includes(name) && isRemoteMcpServer(server) && sendsCredentials(server)
    ? userError("serverError.mcp.personalHeadersShared")
    : null;

const MAX_CONCURRENT_MCP_PROBES = 2;
export const MCP_CONFIG_BUSY = "MCP servers are already being updated.";

export function createMcpConfig(deps: McpConfigDeps & { changed(): void }): McpConfig {
  const { cfg, mcpOAuth, mcpConfigBusy, mcpServerResponse, mcpPolicyRefusal, persistMcpServers, appCatalog, forgetPeople, health } = deps;
  const personalHeaderRefusal = (name: string, server: StoredMcpServer) => personalHeaderValueRefusal(deps.teamConnections.personMcp(), name, server);
  let mcpProbesInFlight = 0;

  const held = async <T,>(run: () => T | Promise<T>): Promise<T | McpConfigRefusal> => {
    if (mcpConfigBusy.get()) return { status: 409, error: MCP_CONFIG_BUSY };
    mcpConfigBusy.set(true);
    try {
      return await run();
    } finally {
      mcpConfigBusy.set(false);
    }
  };
  const announced = (result: McpConfigResult): McpConfigResult => {
    if ("body" in result) deps.changed();
    return result;
  };
  const write = (run: () => McpConfigResult): McpConfigResult => {
    if (mcpConfigBusy.get()) return { status: 409, error: MCP_CONFIG_BUSY };
    mcpConfigBusy.set(true);
    try {
      return announced(run());
    } finally {
      mcpConfigBusy.set(false);
    }
  };
  const saved = (status: number): McpConfigResult => ({ status, body: mcpServerResponse() });
  const stored = (name: string) => {
    const current = cfg.mcpServers ?? {};
    if (!Object.hasOwn(current, name)) return { result: { status: 404, error: mcpServerNotFound(name) } as McpConfigResult };
    const existing = parseStoredMcpServer(name, current[name]);
    return existing.ok ? { current, existing: existing.server } : { result: { status: 400, error: existing.error } as McpConfigResult };
  };
  const refused = (name: string, server: StoredMcpServer): McpConfigResult | null => {
    const personalRefusal = personalHeaderRefusal(name, server);
    if (personalRefusal) return { status: 400, ...personalRefusal };
    const refusal = mcpPolicyRefusal(name, server);
    return refusal ? { status: 403, error: refusal, code: "managed_policy" } : null;
  };

  return {
    busy: mcpConfigBusy,
    add: (name, server, keys) => write(() => {
      const current = cfg.mcpServers ?? {};
      if (Object.hasOwn(current, name)) return { status: 409, error: "An MCP server with that name already exists." };
      const limit = mcpServerLimitError(current, [server]);
      if (limit) return { status: 400, error: limit };
      const refusal = refused(name, server);
      if (refusal) return refusal;
      if (keys) deps.keys?.grant(name, keys);
      persistMcpServers({ ...current, [name]: server });
      appCatalog?.serverChanged(name);
      health?.changed(name);
      deps.connectionsChanged?.("added");
      return saved(201);
    }),
    addMany: (read) => held(async () => {
      const request = await read();
      if ("error" in request) return request;
      const { servers } = request;
      const current = cfg.mcpServers ?? {};
      const names = Object.keys(servers);
      const taken = names.filter((name) => Object.hasOwn(current, name));
      if (taken.length) {
        return { status: 409, error: `Already added: ${taken.join(", ")}. Remove or rename ${taken.length === 1 ? "it" : "them"} first.` };
      }
      const limit = mcpServerLimitError(current, Object.values(servers));
      if (limit) return { status: 400, error: limit };
      const personalRefusal = names.map((name) => personalHeaderRefusal(name, servers[name]!)).find(Boolean);
      if (personalRefusal) return { status: 400, ...personalRefusal };
      const blocked = names.filter((name) => mcpPolicyRefusal(name, servers[name] as object));
      if (blocked.length) return { status: 403, error: `${mcpPolicyRefusal(blocked[0]!, servers[blocked[0]!] as object)} Not approved: ${blocked.join(", ")}.`, code: "managed_policy" };
      persistMcpServers({ ...current, ...servers });
      deps.connectionsChanged?.("added");
      return announced({ status: 201, body: { ...mcpServerResponse(), added: names } });
    }),
    replace: (name, server, keys) => write(() => {
      const found = stored(name);
      if (!found.existing) return found.result!;
      const refusal = refused(name, server);
      if (refusal) return refusal;
      if (keys) deps.keys?.grant(name, keys);
      persistMcpServers({ ...found.current, [name]: server });
      appCatalog?.forgetServer(name);
      appCatalog?.serverChanged(name);
      health?.changed(name);
      // A sign-in belongs to one address: a token never follows the entry elsewhere.
      const before = isRemoteMcpServer(found.existing) ? found.existing.url : null;
      const after = isRemoteMcpServer(server) ? server.url : null;
      // ...and to one sign-in app with its scopes; a new secret for the same app keeps it.
      const app = (entry: StoredMcpServer) => isRemoteMcpServer(entry) && entry.oauth
        ? JSON.stringify([entry.oauth.clientId, entry.oauth.scopes ?? []]) : null;
      if (before !== after || app(found.existing) !== app(server)
        || (after && mcpOAuth.authState(name, after) === "needs-sign-in")) mcpOAuth.forget(name);
      return saved(200);
    }),
    setEnabled: (name, enabled) => write(() => {
      const found = stored(name);
      if (!found.existing) return found.result!;
      if (enabled) {
        const refusal = mcpPolicyRefusal(name, found.existing);
        if (refusal) return { status: 403, error: refusal, code: "managed_policy" };
      }
      persistMcpServers({ ...found.current, [name]: { ...found.existing, enabled } });
      if (enabled) appCatalog?.serverChanged(name);
      health?.changed(name);
      return saved(200);
    }),
    restart: (name) => write(() => {
      const found = stored(name);
      if (!found.existing) return found.result!;
      health?.changed(name);
      return saved(200);
    }),
    setApps: (name, apps) => write(() => {
      const found = stored(name);
      if (!found.existing) return found.result!;
      const { apps: _apps, ...rest } = found.existing;
      persistMcpServers({ ...found.current, [name]: { ...rest, ...(apps ? {} : { apps: false }) } });
      if (apps) appCatalog?.serverChanged(name);
      return saved(200);
    }),
    remove: (name) => write(() => {
      const current = cfg.mcpServers ?? {};
      if (!Object.hasOwn(current, name)) return { status: 404, error: mcpServerNotFound(name) };
      const next = { ...current };
      delete next[name];
      persistMcpServers(next);
      deps.keys?.forgetServer(name);
      mcpOAuth.forget(name);
      forgetPeople?.(name);
      appCatalog?.forgetServer(name);
      deps.connectionsChanged?.("removed");
      return saved(200);
    }),
    test: async (name, { signal, person, asBot, lender }) => {
      const raw = cfg.mcpServers?.[name];
      if (raw === undefined) return { status: 404, error: mcpServerNotFound(name) };
      const parsed = parseStoredMcpServer(name, raw);
      if (!parsed.ok) return { status: 400, error: parsed.error };
      const { runsOn } = parsed.server;
      if (runsOn) return deps.testElsewhere ? deps.testElsewhere(name, { ...parsed.server, runsOn }, lender ?? null, signal) : { status: 409, error: runsElsewhere(runsOn) };
      if (mcpProbesInFlight >= MAX_CONCURRENT_MCP_PROBES) {
        return { status: 429, error: "Two MCP connection tests are already running." };
      }
      mcpProbesInFlight += 1;
      try {
        let target = parsed.server;
        let oauth = mcpOAuth;
        const personal = deps.teamConnections.personMcp().includes(name);
        if (personal && isRemoteMcpServer(target) && !target.oauth && Object.keys(target.headers).length > 0) {
          const own = person?.(target.url);
          if (!own) return { status: 403, ...userError("serverError.mcp.testSignInFirst") };
          oauth = own.oauth;
          target = { ...target, headers: own.key ? { [own.key.header]: own.key.value } : {} };
        } else if (!personal && isRemoteMcpServer(target)) {
          target = { ...target, headers: { ...target.headers, ...postizKeyHeaders(cfg.postiz, name, target) } };
        }
        // Plain servers keep probing as they are saved; the app catalog is keyed by what actually runs.
        let cataloged: StoredMcpServer = parsed.server;
        if (!personal && deps.keys) {
          await deps.keys.warm(name, target);
          const keyed = deps.keys.resolve(name, target, asBot?.id);
          if (!keyed.ok) return { status: 200, body: { ok: false, reason: "keys", error: keyed.why } satisfies McpProbeResult };
          if (keyed.server !== target) cataloged = target = keyed.server;
        }
        let sentSignIn = false;
        if (isRemoteMcpServer(target) && oauth.authState(name, target.url) === "signed-in") {
          const signedIn = (await withMcpSignIn({ [name]: target }, oauth))[name];
          if (signedIn) {
            target = { ...signedIn, enabled: target.enabled } as typeof target;
            sentSignIn = true;
          }
        }
        const options = { tryReadOnlyTool: true, ...(personal ? {} : appCatalog?.probeOptions(name, cataloged) ?? {}), ...(asBot ? { asBot } : isRemoteMcpServer(target) ? {} : { asBot: deps.probeAs?.(target) ?? {} }) };
        const viaBots = isRemoteMcpServer(target) ? deps.botsPath?.() ?? null : null;
        const result = viaBots && isRemoteMcpServer(target)
          ? await probeAsBots(viaBots, name, target, signal, options)
          : await probeMcpServer(target, undefined, signal, options);
        if (!result.ok && result.auth === "required" && isRemoteMcpServer(target)) {
          // Only a Bearer we sent and the server refused drops the sign-in; a probe that sent none must not sign anyone out.
          if (sentSignIn) oauth.markNeedsSignIn(name, target.url);
          else oauth.requireSignIn(name, target.url);
        }
        return { status: 200, body: result };
      } finally {
        mcpProbesInFlight -= 1;
      }
    },
  };
}
