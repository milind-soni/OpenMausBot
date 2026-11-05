import { userError, userErrorFields } from "../user-errors.ts";
import { hostedWorkspaceConfiguration } from "../enterprise.ts";
import { runsElsewhere, type McpConfig, type McpConfigDeps, type McpConfigResult } from "../host/mcp-config.ts";
import { McpOAuthError, McpSignInError, mcpCallbackOrigin } from "../mcp-oauth.ts";
import { isRemoteMcpServer, mcpServerBody, mcpServerServes, parseMcpServerMutation, parseMcpServersImport, parseStoredMcpServer } from "../mcp-registry.ts";
import { personKey } from "../person-key.ts";
import { toolBudgetOf } from "../tool-budgets.ts";
import { isLoopbackHost, isProxied, provesSameOrigin, requestOrigin } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";
import type { json } from "../harness/http.ts";
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

export interface McpServerRouteDeps extends Pick<McpConfigDeps, "cfg" | "sessions" | "mcpOAuth" | "teamConnections" | "cloudHome" | "fallbackPublicUrl" | "savedCustomDomain" | "appCatalog"> {
  config: McpConfig;
  bot(id: string): { id: string; mcpServers?: readonly string[] | null } | null;
  /** Secrets as booleans, sign-in state attached. */
  mcpServerResponse(): { servers: readonly ListedMcpServer[] };
}

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
    cfg, sessions, mcpOAuth, cloudHome: CLOUD_HOME, fallbackPublicUrl: FALLBACK_PUBLIC_URL,
    mcpServerResponse, savedCustomDomain, config,
  } = deps;
  const answer = (res: Parameters<typeof json>[0], send: typeof json, result: McpConfigResult) => "body" in result
    ? send(res, result.status, withServerDetails(result.body))
    : send(res, result.status, { error: result.error, ...userErrorFields(result), ...(result.code ? { code: result.code } : {}) });
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (method === "GET" && path === "/api/mcp/servers") {
      return json(res, 200, withServerDetails(mcpServerResponse()));
    }

    const budgetOf = /^\/api\/bots\/([\w-]+)\/tool-budget$/.exec(path);
    if (method === "GET" && budgetOf) {
      if (!deps.bot(budgetOf[1]!)) return json(res, 404, userError("serverError.bot.missing"));
      return json(res, 200, { budget: toolBudgetOf(budgetOf[1]!) ?? null });
    }

    const ofBot = /^\/api\/bots\/([\w-]+)\/mcp-servers$/.exec(path);
    if (method === "GET" && ofBot) {
      const bot = deps.bot(ofBot[1]!);
      if (!bot) return json(res, 404, userError("serverError.bot.missing"));
      return json(res, 200, { servers: botMcpServers(mcpServerResponse().servers, bot) });
    }

    const mcpTest = /^\/api\/mcp\/servers\/([a-z][a-z0-9_-]{0,31})\/test$/.exec(path);
    if (method === "POST" && mcpTest) {
      const controller = new AbortController();
      const disconnect = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.once("close", disconnect);
      try {
        const name = mcpTest[1]!;
        const result = await config.test(name, {
          signal: controller.signal,
          person: (url) => {
            const member = auth.kind === "session" ? sessionMember(auth.session) : null;
            return member ? deps.teamConnections.people.connection(personKey({ id: "", email: member.member.email }), name, url) : null;
          },
        });
        return answer(res, json, result);
      } finally {
        res.off("close", disconnect);
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
      const body = await readBody(req);
      const name = typeof body?.name === "string" ? body.name : "";
      const parsed = parseMcpServerMutation(name, mcpServerBody(body));
      if (!parsed.ok) return json(res, 400, { error: parsed.error });
      return answer(res, json, config.add(name, parsed.server));
    }

    // The {"mcpServers": {...}} block other agent tools write; imported servers stay disabled until enabled.
    if (method === "POST" && path === "/api/mcp/servers/import") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      return answer(res, json, await config.addMany(async () => {
        const body = await readBody(req);
        const text = typeof body?.json === "string" ? body.json : "";
        if (auth.kind === "session" && !sessions.isLive(auth.session.id)) {
          return { status: 401, error: "unauthorized: this session has expired or was revoked" };
        }
        if (!text.trim()) return { status: 400, error: "Paste the JSON block first." };
        const parsed = parseMcpServersImport(text);
        return parsed.ok ? { servers: parsed.servers } : { status: 400, error: parsed.error };
      }));
    }

    const mcpServerRoute = /^\/api\/mcp\/servers\/([a-z][a-z0-9_-]{0,31})$/.exec(path);
    if (mcpServerRoute && ["PUT", "PATCH", "DELETE"].includes(method)) {
      if (method !== "DELETE" && !String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const name = mcpServerRoute[1]!;
      if (method === "DELETE") return answer(res, json, config.remove(name));
      const body = await readBody(req);
      const current = cfg.mcpServers ?? {};
      if (!Object.hasOwn(current, name)) return json(res, 404, { error: "MCP server not found." });
      const existing = parseStoredMcpServer(name, current[name]);
      if (!existing.ok) return json(res, 400, { error: existing.error });
      if (method === "PATCH") {
        const key = body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 1 ? Object.keys(body)[0] : undefined;
        if ((key !== "enabled" && key !== "apps") || typeof body[key] !== "boolean") {
          return json(res, 400, { error: "Only an enabled or apps boolean can be changed here." });
        }
        return answer(res, json, key === "enabled" ? config.setEnabled(name, body.enabled) : config.setApps(name, body.apps));
      }
      const parsed = parseMcpServerMutation(name, body, existing.server);
      if (!parsed.ok) return json(res, 400, { error: parsed.error });
      return answer(res, json, config.replace(name, parsed.server));
    }
    return PASS;
  };
}
