import type { ChatAppsMcp } from "../chat-apps-mcp.ts";
import type { CloudHomeConfig } from "../cloud-home.ts";
import type { AppConfig } from "../config.ts";
import { hostedWorkspaceConfiguration } from "../enterprise.ts";
import type { TeamConnectionsHost } from "../host/team-connections-host.ts";
import { McpOAuthError, McpSignInError, mcpCallbackOrigin, withMcpSignIn, type McpOAuthManager } from "../mcp-oauth.ts";
import { brokeredServer, type BrokerPath } from "../bot-box/broker-probe.ts";
import { probeMcpServer, type McpProbeOptions, type McpProbeResult } from "../mcp-probe.ts";
import { MAX_MCP_SERVERS, isRemoteMcpServer, mcpServerBody, mcpServerServes, parseMcpServerMutation, parseMcpServersImport, parseStoredMcpServer, type McpRunsOn, type StoredMcpServer, type StoredRemoteMcpServer } from "../mcp-registry.ts";
import { personKey } from "../person-key.ts";
import { postizKeyHeaders } from "../postiz/connection.ts";
import { isLoopbackHost, isProxied, provesSameOrigin, requestOrigin } from "../request-auth.ts";
import type { SessionRegistry } from "../sessions.ts";
import type { BusyFlag } from "./config.ts";
import { PASS, type RouteHandler } from "./table.ts";
import { sessionMember } from "./team-phone.ts";

type ListedMcpServer = { name: string; enabled: boolean; bot?: string; offFor?: readonly string[] };

// Security: built field by field, never spread. The settings list carries commands, arguments and addresses that can
// hold secrets, so it stays closed to phones and this is what they get instead.
function botMcpServers(listed: readonly ListedMcpServer[], bot: { id: string; mcpServers?: readonly string[] | null }) {
  return listed.filter((server) => mcpServerServes(server, bot.id)).map((server) => ({
    name: server.name,
    enabled: server.enabled,
    on: server.enabled && (!bot.mcpServers || bot.mcpServers.includes(server.name)),
    ...(server.offFor?.includes(bot.id) ? { offFor: true as const } : {}),
  }));
}

export interface McpServerRouteDeps {
  cfg: Pick<AppConfig, "mcpServers" | "postiz">;
  bot(id: string): { id: string; mcpServers?: readonly string[] | null } | null;
  sessions: Pick<SessionRegistry, "isLive">;
  mcpOAuth: McpOAuthManager;
  teamConnections: Pick<TeamConnectionsHost, "personMcp" | "people">;
  cloudHome: Pick<CloudHomeConfig, "publicOrigin"> | null;
  fallbackPublicUrl: string | null;
  mcpConfigBusy: BusyFlag;
  /** Secrets as booleans, sign-in state attached. */
  mcpServerResponse(): { servers: readonly ListedMcpServer[] };
  mcpPolicyRefusal(name: string, server: object): string | undefined;
  persistMcpServers(next: Record<string, unknown>): void;
  savedCustomDomain(): string | null;
  appCatalog?: Pick<ChatAppsMcp, "probeOptions" | "serverChanged" | "forgetServer"> & Partial<Pick<ChatAppsMcp, "hasApps">>;
  /** A Team Cloud: each member's own key and sign-in for a removed server go with it. */
  forgetPeople?(name: string): void;
  /** Whether each command server starts for each bot: checked again when one is added, changed or turned on. */
  health?: { changed(name: string): void };
  /** A server was added or removed on purpose: a Cloud home's routines wait while every connection is gone. */
  connectionsChanged?(change: "added" | "removed"): void;
  /** How bots' turns reach a URL server here: through the credential broker where turns are boxed (null: directly). */
  botsPath?(): BrokerPath | null;
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
const runsElsewhere = (runsOn: McpRunsOn) => `This server runs on ${runsOn.label}, so it isn't started here.`;

export function createMcpServerRoutes(deps: McpServerRouteDeps): RouteHandler {
  const withServerDetails = <T,>(body: T): T => {
    const hasApps = deps.appCatalog?.hasApps;
    const servers = (body as { servers?: unknown }).servers;
    if (!Array.isArray(servers)) return body;
    const personal = deps.teamConnections.personMcp();
    return {
      ...body,
      servers: servers.map((server: { name?: unknown }) => {
        const known = typeof server?.name === "string" ? hasApps?.(server.name) : undefined;
        return { ...server, scope: typeof server.name === "string" && personal.includes(server.name) ? "person" : "team",
          ...(known === undefined ? {} : { hasApps: known }) };
      }),
    };
  };
  const {
    cfg, sessions, mcpOAuth, cloudHome: CLOUD_HOME, fallbackPublicUrl: FALLBACK_PUBLIC_URL, mcpConfigBusy,
    mcpServerResponse, mcpPolicyRefusal, persistMcpServers, savedCustomDomain, appCatalog, forgetPeople, health,
  } = deps;
  const MAX_CONCURRENT_MCP_PROBES = 2;
  const personalHeaderRefusal = (name: string, server: StoredMcpServer) =>
    deps.teamConnections.personMcp().includes(name) && isRemoteMcpServer(server) && Object.values(server.headers).some((value) => value !== "")
      ? "Personal MCP header values cannot be saved in shared configuration. Save your key in your personal connection."
      : null;
  let mcpProbesInFlight = 0;
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (method === "GET" && path === "/api/mcp/servers") {
      return json(res, 200, withServerDetails(mcpServerResponse()));
    }

    const ofBot = /^\/api\/bots\/([\w-]+)\/mcp-servers$/.exec(path);
    if (method === "GET" && ofBot) {
      const bot = deps.bot(ofBot[1]!);
      if (!bot) return json(res, 404, { error: "no such bot" });
      return json(res, 200, { servers: botMcpServers(mcpServerResponse().servers, bot) });
    }

    const mcpTest = /^\/api\/mcp\/servers\/([a-z][a-z0-9_-]{0,31})\/test$/.exec(path);
    if (method === "POST" && mcpTest) {
      const raw = cfg.mcpServers?.[mcpTest[1]];
      if (raw === undefined) return json(res, 404, { error: "MCP server not found." });
      const parsed = parseStoredMcpServer(mcpTest[1], raw);
      if (!parsed.ok) return json(res, 400, { error: parsed.error });
      if (parsed.server.runsOn) return json(res, 409, { error: runsElsewhere(parsed.server.runsOn) });
      if (mcpProbesInFlight >= MAX_CONCURRENT_MCP_PROBES) {
        return json(res, 429, { error: "Two MCP connection tests are already running." });
      }
      const controller = new AbortController();
      const disconnect = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.once("close", disconnect);
      mcpProbesInFlight += 1;
      try {
        const name = mcpTest[1];
        let target = parsed.server;
        let oauth = mcpOAuth;
        const personal = deps.teamConnections.personMcp().includes(name);
        if (personal && isRemoteMcpServer(target) && !target.oauth && Object.keys(target.headers).length > 0) {
          const member = auth.kind === "session" ? sessionMember(auth.session) : null;
          if (!member) return json(res, 403, { error: "Sign in to the team to test your own connection." });
          const person = personKey({ id: "", email: member.member.email });
          oauth = deps.teamConnections.people.oauth(person);
          const key = deps.teamConnections.people.key(person, name, target.url);
          target = { ...target, headers: key ? { [key.header]: key.value } : {} };
        } else if (!personal && isRemoteMcpServer(target)) {
          target = { ...target, headers: { ...target.headers, ...postizKeyHeaders(cfg.postiz, name, target) } };
        }
        if (isRemoteMcpServer(target) && oauth.authState(name, target.url) === "signed-in") {
          const signedIn = (await withMcpSignIn({ [name]: target }, oauth))[name];
          if (signedIn) target = { ...signedIn, enabled: target.enabled } as typeof target;
        }
        const options = personal ? {} : appCatalog?.probeOptions(name, parsed.server) ?? {};
        const viaBots = isRemoteMcpServer(target) ? deps.botsPath?.() ?? null : null;
        const result = viaBots && isRemoteMcpServer(target)
          ? await probeAsBots(viaBots, name, target, controller.signal, options)
          : await probeMcpServer(target, undefined, controller.signal, options);
        if (!result.ok && result.auth === "required" && isRemoteMcpServer(target)) oauth.markNeedsSignIn(name, target.url);
        return json(res, 200, result);
      } finally {
        res.off("close", disconnect);
        mcpProbesInFlight -= 1;
      }
    }

    const mcpSignIn = /^\/api\/mcp\/servers\/([a-z][a-z0-9_-]{0,31})\/(sign-in|sign-out)(?:\/([0-9a-f-]{36}))?$/.exec(path);
    if (mcpSignIn) {
      const [, name, action, flowId] = mcpSignIn;
      const raw = cfg.mcpServers?.[name!];
      const parsed = raw === undefined ? null : parseStoredMcpServer(name!, raw);
      if (!parsed?.ok) return json(res, 404, { error: "MCP server not found." });
      if (!isRemoteMcpServer(parsed.server)) return json(res, 400, { error: "Only servers reached by URL can be signed in to." });
      if (parsed.server.runsOn) return json(res, 409, { error: runsElsewhere(parsed.server.runsOn) });
      const url = parsed.server.url;
      if (action === "sign-out" && method === "POST" && !flowId) {
        await mcpOAuth.signOut(name!, url);
        return json(res, 200, withServerDetails(mcpServerResponse()));
      }
      const owner = auth.kind === "session" ? auth.session.id : "loopback";
      res.setHeader("Cache-Control", "no-store");
      try {
        if (action === "sign-in" && method === "GET" && flowId) {
          const status = mcpOAuth.status(name!, flowId, owner);
          return status ? json(res, 200, { auth: status }) : json(res, 404, { error: "This sign-in is no longer available in this browser. Start again." });
        }
        if (action === "sign-in" && method === "DELETE") {
          mcpOAuth.cancelFlow(name!, owner, flowId);
          return json(res, 200, { ok: true });
        }
        if (action === "sign-in" && method === "POST" && flowId) {
          if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
            return json(res, 415, { error: "content-type must be application/json" });
          }
          const body = await readBody(req, 20_480);
          if (typeof body?.callbackUrl !== "string") return json(res, 400, { error: "A complete callbackUrl is required." });
          return json(res, 200, { auth: await mcpOAuth.completeCallback(name!, flowId, body.callbackUrl, owner) });
        }
        if (action === "sign-in" && method === "POST" && !flowId) {
          // A browser on another computer comes back to the https address it uses now, when this server vouches for it.
          const remote = auth.kind === "session" && (isProxied(req) || !isLoopbackHost(req.headers.host));
          const origin = remote
            ? mcpCallbackOrigin(provesSameOrigin(req) ? requestOrigin(req) : null,
              [CLOUD_HOME?.publicOrigin, hostedWorkspaceConfiguration()?.tenant.origin, savedCustomDomain(), FALLBACK_PUBLIC_URL])
            : null;
          const started = await mcpOAuth.start(name!, url, undefined, owner, { remote, origin });
          if (auth.kind === "session" && !sessions.isLive(auth.session.id)) {
            mcpOAuth.revokeOwner(owner);
            return json(res, 401, { error: "Your session ended. Start a new sign-in." });
          }
          return json(res, 200, { auth: started });
        }
      } catch (error) {
        if (error instanceof McpSignInError) return json(res, error.status, { error: error.message });
        if (error instanceof McpOAuthError) return json(res, 400, { error: error.message, code: error.code });
        if (method === "POST" && !flowId) return json(res, 502, { error: error instanceof Error ? error.message : "Sign-in could not start." });
        throw error;
      }
      return json(res, 405, { error: "method not allowed" });
    }

    if (method === "POST" && path === "/api/mcp/servers") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      if (mcpConfigBusy.get()) return json(res, 409, { error: "MCP servers are already being updated." });
      mcpConfigBusy.set(true);
      try {
        const body = await readBody(req);
        const name = typeof body?.name === "string" ? body.name : "";
        const current = cfg.mcpServers ?? {};
        if (Object.hasOwn(current, name)) return json(res, 409, { error: "An MCP server with that name already exists." });
        if (Object.keys(current).length >= MAX_MCP_SERVERS) {
          return json(res, 400, { error: `You can add at most ${MAX_MCP_SERVERS} MCP servers.` });
        }
        const parsed = parseMcpServerMutation(name, mcpServerBody(body));
        if (!parsed.ok) return json(res, 400, { error: parsed.error });
        const personalRefusal = personalHeaderRefusal(name, parsed.server);
        if (personalRefusal) return json(res, 400, { error: personalRefusal });
        const refusal = mcpPolicyRefusal(name, parsed.server);
        if (refusal) return json(res, 403, { error: refusal, code: "managed_policy" });
        persistMcpServers({ ...current, [name]: parsed.server });
        appCatalog?.serverChanged(name);
        health?.changed(name);
        deps.connectionsChanged?.("added");
        return json(res, 201, withServerDetails(mcpServerResponse()));
      } finally {
        mcpConfigBusy.set(false);
      }
    }

    // The {"mcpServers": {...}} block other agent tools write; imported servers stay disabled until enabled.
    if (method === "POST" && path === "/api/mcp/servers/import") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      if (mcpConfigBusy.get()) return json(res, 409, { error: "MCP servers are already being updated." });
      mcpConfigBusy.set(true);
      try {
        const body = await readBody(req);
        const text = typeof body?.json === "string" ? body.json : "";
        if (auth.kind === "session" && !sessions.isLive(auth.session.id)) {
          return json(res, 401, { error: "unauthorized: this session has expired or was revoked" });
        }
        if (!text.trim()) return json(res, 400, { error: "Paste the JSON block first." });
        const parsed = parseMcpServersImport(text);
        if (!parsed.ok) return json(res, 400, { error: parsed.error });
        const current = cfg.mcpServers ?? {};
        const names = Object.keys(parsed.servers);
        const taken = names.filter((name) => Object.hasOwn(current, name));
        if (taken.length) {
          return json(res, 409, { error: `Already added: ${taken.join(", ")}. Remove or rename ${taken.length === 1 ? "it" : "them"} first.` });
        }
        if (Object.keys(current).length + names.length > MAX_MCP_SERVERS) {
          return json(res, 400, { error: `You can add at most ${MAX_MCP_SERVERS} MCP servers.` });
        }
        const personalRefusal = names.map((name) => personalHeaderRefusal(name, parsed.servers[name]!)).find(Boolean);
        if (personalRefusal) return json(res, 400, { error: personalRefusal });
        const refused = names.filter(name => mcpPolicyRefusal(name, parsed.servers[name] as object));
        if (refused.length) return json(res, 403, { error: `${mcpPolicyRefusal(refused[0]!, parsed.servers[refused[0]!] as object)} Not approved: ${refused.join(", ")}.`, code: "managed_policy" });
        persistMcpServers({ ...current, ...parsed.servers });
        deps.connectionsChanged?.("added");
        return json(res, 201, { ...withServerDetails(mcpServerResponse()), added: names });
      } finally {
        mcpConfigBusy.set(false);
      }
    }

    const mcpServerRoute = /^\/api\/mcp\/servers\/([a-z][a-z0-9_-]{0,31})$/.exec(path);
    if (mcpServerRoute && ["PUT", "PATCH", "DELETE"].includes(method)) {
      if (method !== "DELETE" && !String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      if (mcpConfigBusy.get()) return json(res, 409, { error: "MCP servers are already being updated." });
      mcpConfigBusy.set(true);
      try {
        const name = mcpServerRoute[1];
        const current = cfg.mcpServers ?? {};
        if (!Object.hasOwn(current, name)) return json(res, 404, { error: "MCP server not found." });
        if (method === "DELETE") {
          const next = { ...current };
          delete next[name];
          persistMcpServers(next);
          mcpOAuth.forget(name);
          forgetPeople?.(name);
          appCatalog?.forgetServer(name);
          deps.connectionsChanged?.("removed");
          return json(res, 200, withServerDetails(mcpServerResponse()));
        }

        const existing = parseStoredMcpServer(name, current[name]);
        if (!existing.ok) return json(res, 400, { error: existing.error });
        const body = await readBody(req);
        if (method === "PATCH") {
          const key = body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 1 ? Object.keys(body)[0] : undefined;
          if ((key !== "enabled" && key !== "apps") || typeof body[key] !== "boolean") {
            return json(res, 400, { error: "Only an enabled or apps boolean can be changed here." });
          }
          const { apps: _apps, ...rest } = existing.server;
          persistMcpServers({ ...current, [name]: key === "enabled" ? { ...existing.server, enabled: body.enabled } : { ...rest, ...(body.apps ? {} : { apps: false }) } });
          if (body[key] === true) appCatalog?.serverChanged(name);
          if (key === "enabled") health?.changed(name);
          return json(res, 200, withServerDetails(mcpServerResponse()));
        }

        const parsed = parseMcpServerMutation(name, body, existing.server);
        if (!parsed.ok) return json(res, 400, { error: parsed.error });
        const personalRefusal = personalHeaderRefusal(name, parsed.server);
        if (personalRefusal) return json(res, 400, { error: personalRefusal });
        const refusal = mcpPolicyRefusal(name, parsed.server);
        if (refusal) return json(res, 403, { error: refusal, code: "managed_policy" });
        persistMcpServers({ ...current, [name]: parsed.server });
        appCatalog?.forgetServer(name);
        appCatalog?.serverChanged(name);
        health?.changed(name);
        // A sign-in belongs to one address: a token never follows the entry elsewhere.
        const before = isRemoteMcpServer(existing.server) ? existing.server.url : null;
        const after = isRemoteMcpServer(parsed.server) ? parsed.server.url : null;
        // ...and to one sign-in app with its scopes; a new secret for the same app keeps it.
        const app = (server: typeof existing.server) => isRemoteMcpServer(server) && server.oauth
          ? JSON.stringify([server.oauth.clientId, server.oauth.scopes ?? []]) : null;
        if (before !== after || app(existing.server) !== app(parsed.server)
          || (after && mcpOAuth.authState(name, after) === "needs-sign-in")) mcpOAuth.forget(name);
        return json(res, 200, withServerDetails(mcpServerResponse()));
      } finally {
        mcpConfigBusy.set(false);
      }
    }
    return PASS;
  };
}
