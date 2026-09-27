// Email sign-in for the public NATION server, and the door to each person's
// own workspace (server/accounts.ts, server/workspace-host.ts).
//
//   POST /api/auth/magic/start   {email}  emails a one-time sign-in link
//   POST /api/auth/magic/peek    {token}  the address a link is for (the
//                                         confirm screen), without using it
//   POST /api/auth/magic/verify  {token}  uses the link and signs in
//
// Who ends up where after verify:
//   - an address on this server's own sign-in list (Settings, or
//     OMB_SIGNIN_EMAILS / OMB_SIGNIN_MEMBER_EMAILS) gets an ordinary session
//     on this server's desk, exactly like the emailed-code sign-in;
//   - anyone else gets an account cookie for their own workspace, created
//     on their first sign-in. Every API request carrying that cookie is
//     forwarded to the workspace's own server and never reaches this desk.
//
// The link opens the web app at `#login=<token>`: a fragment, so the token
// never reaches a web server's logs, and the app asks before using it, so a
// mail scanner that opens links cannot spend it.
import type { IncomingMessage, ServerResponse } from "node:http";
import { ACCOUNT_COOKIE, magicLinkTtlMs, normalizeEmail, type AccountStore, type WorkspaceRef } from "./accounts.ts";
import type { AccountMailer } from "./account-mail.ts";
import { json, readBody } from "./harness/http.ts";
import {
  clearSessionCookie,
  clientAddress,
  isLoopbackHost,
  isProxied,
  isSameOrigin,
  labelFromUserAgent,
  parseCookies,
  requestOrigin,
  serializeSessionCookie,
} from "./request-auth.ts";
import { cookieMaxAgeSeconds, type Scope, type SessionRegistry } from "./sessions.ts";

export const LINK_EXPIRED = "This sign-in link has expired or was already used. Request a new one.";
export const SIGNED_OUT = "Your sign-in has ended. Sign in again.";
export const SIGNUPS_FULL = "Nation Team Chat is not taking new sign-ups right now. Try again later.";

/** Runs each account's workspace (server/workspace-host.ts). */
export interface WorkspaceRouter {
  /** Start the workspace if it is not running. */
  ensure(ref: WorkspaceRef): Promise<unknown>;
  /** Answer this request from the workspace, streaming both ways. */
  forward(req: IncomingMessage, res: ServerResponse, ref: WorkspaceRef, clientIp: string): Promise<void>;
}

export interface AccountGatewayDeps {
  accounts: AccountStore;
  host: WorkspaceRouter;
  mailer: AccountMailer;
  /** This server's own desk: its sessions, cookie and sign-in list. */
  sessions: Pick<SessionRegistry, "issue" | "attemptAllowed" | "noteFailure" | "clearFailures">;
  founderCookie: string;
  founderScopes(email: string): Scope[] | null;
  /** The web app's public address (OMB_PUBLIC_URL or the verified custom domain). */
  appUrl(): string | null;
  environmentId: string;
  maxWorkspaces?: number;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

export interface AccountGateway {
  /** Sign-in routes, and every API request from a browser signed in to an
   * account. True when this answered; false leaves the request to the desk. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
}

/** a…e@example.com: enough to read a log, not enough to collect addresses from one. */
export function maskEmail(email: string): string {
  const [name = "", domain = ""] = email.split("@");
  return `${name.slice(0, 1)}…${name.length > 1 ? name.slice(-1) : ""}@${domain}`;
}

export function createAccountGateway(deps: AccountGatewayDeps): AccountGateway {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line: string) => console.warn(line));
  const maxWorkspaces = deps.maxWorkspaces ?? 500;
  const secure = (req: IncomingMessage) => requestOrigin(req)?.startsWith("https://") === true;
  const minutes = Math.round(magicLinkTtlMs(env) / 60_000);

  /** Where a link opens. Never from request headers on a public address: a
   * forged Host would otherwise send a real sign-in email that points at
   * someone else's site. A loopback request (development, fixtures) may use
   * its own origin. */
  const linkBase = (req: IncomingMessage): string | null => {
    const configured = deps.appUrl();
    if (configured) return configured.replace(/\/+$/, "");
    if (!isProxied(req) && isLoopbackHost(String(req.headers.host ?? ""))) return requestOrigin(req);
    return null;
  };

  const readJson = async (req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> => {
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) {
      json(res, 415, { error: "send the sign-in request as JSON (content-type: application/json)" });
      return null;
    }
    try {
      const body: unknown = await readBody(req, 8 * 1024);
      return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
    } catch (error) {
      json(res, (error as { status?: number }).status ?? 400, { error: "invalid sign-in request" });
      return null;
    }
  };

  const signIn = async (req: IncomingMessage, res: ServerResponse, action: string): Promise<void> => {
    res.setHeader("cache-control", "no-store");
    if (deps.mailer.kind === "none") return json(res, 404, { error: "Email sign-in is not set up on this server." });
    const source = clientAddress(req, env);
    const lock = deps.sessions.attemptAllowed(source);
    if (!lock.ok) return json(res, 429, { error: `Too many attempts from your network. Try again in ${Math.ceil(lock.retryAfterMs / 1000)} seconds.` });
    const body = await readJson(req, res);
    if (!body) return;

    if (action === "start") {
      const email = normalizeEmail(body.email);
      if (!email) return json(res, 400, { error: "Enter a valid email address." });
      const base = linkBase(req);
      if (!base) {
        log("email sign-in: no public address to put in a link; set OMB_PUBLIC_URL");
        return json(res, 503, { error: "Email sign-in is not available right now." });
      }
      const requested = deps.accounts.requestMagicLink(email, source);
      if (!requested.ok) return json(res, 429, { error: requested.error });
      try {
        await deps.mailer.send({ to: email, link: `${base}/#login=${requested.token}`, expiresInMinutes: minutes });
      } catch (error) {
        log(`email sign-in: sending to ${maskEmail(email)} failed: ${error instanceof Error ? error.message : String(error)}`);
        return json(res, 502, { error: "We could not send the email. Try again in a minute." });
      }
      return json(res, 200, { ok: true, expiresAt: requested.expiresAt });
    }

    const email = deps.accounts.peekMagicLink(body.token);
    if (!email) {
      deps.sessions.noteFailure(source);
      return json(res, 401, { error: LINK_EXPIRED });
    }
    if (action === "peek") return json(res, 200, { email });

    // verify: a new workspace must fit before the link is spent.
    const founder = deps.founderScopes(email);
    const existing = deps.accounts.userByEmail(email);
    if (!founder && !(existing && deps.accounts.workspaceOf(existing.id)) && deps.accounts.workspaceCount() >= maxWorkspaces) {
      log(`email sign-in: ${maxWorkspaces} workspaces exist (NATION_WORKSPACE_MAX_TOTAL); ${maskEmail(email)} was not given one`);
      return json(res, 503, { error: SIGNUPS_FULL });
    }
    if (deps.accounts.consumeMagicLink(body.token) !== email) {
      deps.sessions.noteFailure(source);
      return json(res, 401, { error: LINK_EXPIRED });
    }
    deps.sessions.clearFailures(source);
    const label = (typeof body.label === "string" && body.label.trim()) || labelFromUserAgent(req.headers["user-agent"]);
    const user = deps.accounts.ensureUser(email);
    if (founder) {
      const issued = deps.sessions.issue({ label, scopes: founder, userId: user.id, email });
      deps.accounts.noteLogin(user.id);
      res.setHeader("set-cookie", [
        serializeSessionCookie(deps.founderCookie, issued.token, { secure: secure(req), maxAgeSeconds: cookieMaxAgeSeconds(issued.session) }),
        clearSessionCookie(ACCOUNT_COOKIE),
      ]);
      return json(res, 200, { ok: true, destination: "desk" });
    }
    const ensured = deps.accounts.ensureWorkspace(user.id, maxWorkspaces);
    if (!ensured) return json(res, 503, { error: SIGNUPS_FULL });
    const opened = deps.accounts.openSession(user.id, label);
    res.setHeader("set-cookie", [
      serializeSessionCookie(ACCOUNT_COOKIE, opened.token, { secure: secure(req), maxAgeSeconds: cookieMaxAgeSeconds(opened.session) }),
      clearSessionCookie(deps.founderCookie),
    ]);
    if (ensured.created) log(`email sign-in: new workspace ${ensured.workspace.id} for ${maskEmail(email)}`);
    // Start it now so the app's first requests do not wait for it.
    void deps.host.ensure({ id: ensured.workspace.id, userId: user.id, email }).catch((error) => {
      log(`workspace ${ensured.workspace.id} did not start after sign-in: ${error instanceof Error ? error.message : String(error)}`);
    });
    return json(res, 200, { ok: true, destination: "workspace", created: ensured.created });
  };

  return {
    async handle(req, res, url) {
      const path = url.pathname;
      const method = req.method ?? "GET";
      const magic = /^\/api\/auth\/magic\/(start|peek|verify)$/.exec(path);
      if (magic && method === "POST") {
        await signIn(req, res, magic[1]!);
        return true;
      }
      const token = parseCookies(req.headers.cookie).get(ACCOUNT_COOKIE);
      if (!token || !path.startsWith("/api/")) return false;

      // From here the request belongs to an account and never reaches this desk.
      if (!isSameOrigin(req, env)) {
        json(res, 403, { error: "forbidden: cross-origin request" });
        return true;
      }
      const identity = deps.accounts.authenticate(token);
      if (!identity) {
        res.setHeader("set-cookie", clearSessionCookie(ACCOUNT_COOKIE));
        json(res, 401, { error: SIGNED_OUT });
        return true;
      }
      // The workspace server's own loopback routes are for this server alone
      // (they also need its per-start key, which is never forwarded).
      if (path.startsWith("/api/workspace-host/")) {
        json(res, 404, { error: "not found" });
        return true;
      }
      if (method === "POST" && path === "/api/auth/logout") {
        deps.accounts.revokeSession(identity.session.id);
        res.setHeader("set-cookie", clearSessionCookie(ACCOUNT_COOKIE));
        json(res, 200, { ok: true });
        return true;
      }
      // The cookie's term slides with the session's (accounts.ts `authenticate`).
      res.setHeader("set-cookie", serializeSessionCookie(ACCOUNT_COOKIE, token, { secure: secure(req), maxAgeSeconds: cookieMaxAgeSeconds(identity.session) }));
      if (method === "GET" && path === "/api/auth/session") {
        res.setHeader("cache-control", "no-store");
        json(res, 200, {
          kind: "session",
          id: identity.session.id,
          label: identity.session.label,
          scopes: ["client"],
          expiresAt: identity.session.expiresAt,
          via: "cookie",
          environmentId: deps.environmentId,
          email: identity.user.email,
          account: { workspaceId: identity.workspace.id },
        });
        return true;
      }
      await deps.host.forward(req, res, { id: identity.workspace.id, userId: identity.user.id, email: identity.user.email }, clientAddress(req, env));
      return true;
    },
  };
}
