// A Team Cloud's connections, the team's or each person's.
//   PUT /api/team/connection-scopes { kind: "app" | "mcp", id, scope: "team" | "person" }   an admin: who connects it
//   GET /api/team/my-connections                                                           the person's own, and what is theirs to connect
//   POST /api/team/my-connections/apps/:slug/connect            → { url }   their own sign-in to the app (a new tab)
//   DELETE /api/team/my-connections/apps/:slug
//   POST /api/team/my-connections/mcp/:name/sign-in             → { auth }  their own sign-in to the server (a new tab)
//   PUT /api/team/my-connections/mcp/:name/key { value }                    their own key, never read back
//   DELETE /api/team/my-connections/mcp/:name
// The Admin's Cloud page calls these with a session it opened for the person asking (a User's is a client session).
// Every one acts on the session's own person only, and none answers with a key, a token or a path of an address.
import type { AdminActionRow } from "../admin-activity.ts";
import type { AppConfig } from "../config.ts";
import type { TeamConnectionsHost } from "../host/team-connections-host.ts";
import { McpOAuthError, McpSignInError, mcpCallbackOrigin } from "../mcp-oauth.ts";
import { isRemoteMcpServer, parseStoredMcpServer } from "../mcp-registry.ts";
import { personKey } from "../person-key.ts";
import { provesSameOrigin, requestOrigin, type RequestAuth } from "../request-auth.ts";
import { APP_SLUG, appLabel, MCP_NAME, personKeyHeader } from "../team-connections.ts";
import { sessionMember } from "./team-phone.ts";
import { PASS, type RouteHandler } from "./table.ts";
import type * as Composio from "../composio.ts";

export const CONNECTION_SCOPES_PATH = "/api/team/connection-scopes";
export const MY_CONNECTIONS_PATH = "/api/team/my-connections";

export interface TeamConnectionRouteDeps {
  host: TeamConnectionsHost;
  cfg: () => AppConfig;
  composio: Pick<typeof Composio, "configured" | "connectedServices" | "authorizeService" | "removeService">;
  /** This server's own https address, where a member's MCP sign-in comes back. */
  publicOrigin: string | null;
  /** An admin's change, for the team's admin activity. */
  record?(auth: RequestAuth, row: Omit<AdminActionRow, "at" | "actor">): void;
}

const host = (url: string) => { try { return new URL(url).host; } catch { return null; } };

export function createTeamConnectionRoutes(deps: TeamConnectionRouteDeps): RouteHandler {
  const team = deps.host.team;
  const server = (name: string) => {
    const raw = deps.cfg().mcpServers?.[name];
    const parsed = raw === undefined ? null : parseStoredMcpServer(name, raw);
    return parsed?.ok ? parsed.server : null;
  };
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== CONNECTION_SCOPES_PATH && path !== MY_CONNECTIONS_PATH && !path.startsWith(`${MY_CONNECTIONS_PATH}/`)) return PASS;
    if (!team) return json(res, 404, { error: "Only a team's Cloud has connections for each person." });

    if (path === CONNECTION_SCOPES_PATH) {
      if (method !== "PUT") return json(res, 405, { error: "method not allowed" });
      const body = await readBody(req);
      const kind = body?.kind, id = typeof body?.id === "string" ? body.id.trim().toLowerCase() : "", scope = body?.scope;
      if ((kind !== "app" && kind !== "mcp") || (scope !== "team" && scope !== "person") || !(kind === "app" ? APP_SLUG : MCP_NAME).test(id)) {
        return json(res, 400, { error: "Name an app or an MCP server, and who connects it: the team or each person." });
      }
      if (kind === "mcp") {
        const found = server(id);
        if (!found) return json(res, 404, { error: "MCP server not found." });
        if (scope === "person" && !isRemoteMcpServer(found)) return json(res, 409, { error: "Only a server reached by its address can be connected by each person." });
      }
      const before = deps.host.scopes.scope(kind, id);
      if (before !== scope) {
        deps.host.scopes.set(kind, id, scope);
        deps.record?.(auth, { category: kind === "mcp" ? "mcp" : "config", action: `${kind}.update`, target: { kind, id },
          changed: [scope === "person" ? "each person connects their own" : "connected for the whole team"] });
      }
      return json(res, 200, { scopes: { apps: deps.host.scopes.person("app"), mcp: deps.host.scopes.person("mcp") } });
    }

    // Everything below is the person's own: a session the Admin opened for a member, never the loopback or a device.
    const member = auth.kind === "session" ? sessionMember(auth.session) : null;
    if (!member || auth.kind !== "session") return json(res, 403, { error: `Sign in to ${team.name} to connect your own apps.` });
    const person = personKey({ id: "", email: member.member.email });
    const email = member.member.email;
    const cfg = deps.cfg();

    if (path === MY_CONNECTIONS_PATH) {
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      const apps = deps.host.personApps();
      const access = deps.host.people.appsAccess(person);
      const states = access && apps.length ? await deps.composio.connectedServices(cfg, access).catch(() => null) : null;
      return json(res, 200, {
        team: { id: team.id, name: team.name },
        link: deps.host.link(),
        email,
        apps: apps.map((slug) => {
          const state = states?.[slug];
          return { slug, name: appLabel(slug), connected: state?.connected === true,
            accounts: (state?.accounts ?? []).map((account) => ({ id: account.id, alias: account.alias?.trim() || null, status: account.status })) };
        }),
        mcp: deps.host.personMcp().flatMap((name) => {
          const stored = server(name);
          if (!stored || !isRemoteMcpServer(stored)) return [];
          const signedIn = deps.host.people.oauth(person).authState(name, stored.url) === "signed-in";
          const key = deps.host.people.key(person, name, stored.url) !== null;
          return [{ name, host: host(stored.url), connected: signedIn || key, how: signedIn ? "sign-in" : key ? "key" : null,
            offers: stored.oauth || !Object.keys(stored.headers).length ? "sign-in" : "key" }];
        }),
      });
    }

    const app = /^\/api\/team\/my-connections\/apps\/([^/]+)(\/connect)?$/.exec(path);
    if (app) {
      const slug = decodeURIComponent(app[1]!).toLowerCase();
      if (!APP_SLUG.test(slug) || !deps.host.personApps().includes(slug)) {
        return json(res, 409, { error: `${appLabel(slug)} is ${team.name}'s, connected once for everyone by an admin.` });
      }
      if (app[2] && method === "POST") {
        const access = await deps.host.people.ensureAppsAccess(person, email);
        if (!access) return json(res, 503, { error: "Connected apps aren't available on this Cloud right now. Try again in a minute." });
        try {
          return json(res, 200, await deps.composio.authorizeService(cfg, slug, null, access));
        } catch (error) {
          const status = (error as { status?: number }).status;
          return json(res, typeof status === "number" && status >= 400 && status < 500 ? status : 502, { error: error instanceof Error ? error.message : "The app's sign-in couldn't start." });
        }
      }
      if (!app[2] && method === "DELETE") {
        const access = deps.host.people.appsAccess(person);
        if (access) await deps.composio.removeService(cfg, slug, access);
        return json(res, 200, { ok: true });
      }
      return json(res, 405, { error: "method not allowed" });
    }

    const mcp = /^\/api\/team\/my-connections\/mcp\/([a-z][a-z0-9_-]{0,31})(\/sign-in|\/key)?$/.exec(path);
    if (mcp) {
      const name = mcp[1]!, stored = server(name);
      if (!stored || !deps.host.personMcp().includes(name) || !isRemoteMcpServer(stored)) {
        return json(res, 409, { error: `${name} is ${team.name}'s, connected once for everyone by an admin.` });
      }
      deps.host.people.remember(person, email);
      if (mcp[2] === "/sign-in" && method === "POST") {
        const origin = mcpCallbackOrigin(provesSameOrigin(req) ? requestOrigin(req) : null, [deps.publicOrigin]);
        try {
          res.setHeader("Cache-Control", "no-store");
          return json(res, 200, { auth: await deps.host.people.oauth(person).start(name, stored.url, undefined, auth.session.id, { remote: origin !== null, origin }) });
        } catch (error) {
          if (error instanceof McpOAuthError && error.code === "not-oauth") return json(res, 400, { error: "This server doesn't offer a sign-in. Add your own key instead.", code: error.code });
          if (error instanceof McpOAuthError) return json(res, 400, { error: error.message, code: error.code });
          if (error instanceof McpSignInError) return json(res, error.status, { error: error.message });
          return json(res, 502, { error: error instanceof Error ? error.message : "Sign-in could not start." });
        }
      }
      if (mcp[2] === "/key" && method === "PUT") {
        const body = await readBody(req, 4096);
        const value = typeof body?.value === "string" ? body.value.trim() : "";
        if (value.length < 8 || value.length > 512 || !/^[\x21-\x7e]+(?: [\x21-\x7e]+)?$/.test(value)) return json(res, 400, { error: "Paste the key alone." });
        const headerKeys = Object.keys(stored.headers);
        deps.host.people.putKey(person, email, name, { url: stored.url, ...personKeyHeader(headerKeys, value) });
        return json(res, 200, { ok: true });
      }
      if (!mcp[2] && method === "DELETE") {
        await deps.host.people.oauth(person).signOut(name, stored.url);
        deps.host.people.deleteKey(person, name);
        return json(res, 200, { ok: true });
      }
      return json(res, 405, { error: "method not allowed" });
    }
    return json(res, 404, { error: "not found" });
  };
}
