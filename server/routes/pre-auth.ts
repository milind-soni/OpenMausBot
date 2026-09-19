// The pre-auth dispatch head — extracted verbatim from index.ts's
// handleRequest: the hosted-workspace readiness probe, the hosted-portal
// sign-in redirect and its unavailable fallback, static and environment
// discovery, the custom-domain challenge, and the public email-code and
// pairing sign-ins (POST /api/auth/email/start, /api/auth/email/verify,
// POST /api/auth/pair, POST /api/pair). These blocks run before any auth
// exists, so the handler takes Omit<RouteContext, "auth"> — method, path
// and url only — and returns false for anything it does not own, letting
// index.ts fall through to resolveRequestAuth exactly where the region
// sat. The !gate.auth /api/health and /api/brand probes and the gate-fail
// reply stay in index.ts: they read the gate's result and are the gate
// boundary itself. sessions, emailSignIn, the custom-domain verifier and
// serveStatic are index-local and cross via deps; workspaceAccess is a let
// index.ts assigns only after this factory is wired, so it crosses as a
// thunk resolved at call time.
import type { IncomingMessage, ServerResponse } from "node:http";

import { json, readBody, type RouteContext } from "./http.ts";
import { cfg, ENVIRONMENT_ID } from "../runtime.ts";
import { sharedComputersEnabled } from "../config.ts";
import { environmentDescriptor } from "../environment.ts";
import { entitled, hostedWorkspaceConfiguration, type WorkspaceAccess } from "../enterprise.ts";
import { HOSTED_CONTRACT_HEADER, HOSTED_CONTRACT_METADATA, HOSTED_CONTRACT_VERSION } from "../hosted-contract.ts";
import {
  isLoopbackHost,
  isProxied,
  labelFromUserAgent,
  requestOrigin,
  requestSource,
  serializeSessionCookie,
} from "../request-auth.ts";
import { cookieMaxAgeSeconds, type SessionRegistry } from "../sessions.ts";
import type { createCustomDomainVerifier } from "../custom-domain.ts";
import type { createEmailSignIn } from "../account-signin.ts";

type CustomDomainVerifier = ReturnType<typeof createCustomDomainVerifier>;
type EmailSignIn = ReturnType<typeof createEmailSignIn>;

/** These routes run before the auth gate resolves, so the dispatch context
 * carries no auth: method, path and url only. */
type PreAuthContext = Omit<RouteContext, "auth">;

export function createPreAuthRoutes(deps: {
  sessions: SessionRegistry;
  emailSignIn: EmailSignIn;
  customDomainVerifier: CustomDomainVerifier;
  SESSION_COOKIE: string;
  DESKTOP_MANAGED: boolean;
  HOSTED_WORKSPACE: boolean;
  serveStatic(res: ServerResponse, path: string): boolean;
  workspaceAccess(): WorkspaceAccess | null;
}) {
  return async (req: IncomingMessage, res: ServerResponse, ctx: PreAuthContext): Promise<boolean> => {
    const { method, path, url } = ctx;
    const {
      sessions,
      emailSignIn,
      customDomainVerifier,
      SESSION_COOKIE,
      DESKTOP_MANAGED,
      HOSTED_WORKSPACE,
      serveStatic,
      workspaceAccess,
    } = deps;
    // Unlike the legacy reachability probe, this attests the running
    // server's portal-membership capability, including live entitlement.
    if (method === "GET" && path === "/api/health/hosted") {
      res.setHeader("cache-control", "no-store");
      const hosted = hostedWorkspaceConfiguration();
      if (!hosted?.portalMembership || !workspaceAccess() || !entitled("admin")) {
        json(res, 503, { error: "Hosted workspace readiness is unavailable." });
        return true;
      }
      res.setHeader(HOSTED_CONTRACT_HEADER, String(HOSTED_CONTRACT_VERSION));
      json(res, 200, { ok: true, service: "openmausbot", membershipAuthority: "portal", workspace: hosted.workspace, ...HOSTED_CONTRACT_METADATA });
      return true;
    }
    // Hosted workspaces have one sign-in authority. A missing optional layer
    // must not accidentally reactivate legacy email/QR credential minting.
    if (HOSTED_WORKSPACE) {
      if (method === "POST" && ["/api/auth/pair", "/api/pair", "/api/auth/pairing", "/api/auth/email/start", "/api/auth/email/verify"].includes(path)) {
        json(res, 403, { error: "Sign in through the workspace portal." });
        return true;
      }
      const access = workspaceAccess();
      if (access) {
        if (await access.handlePublic(req, res, url)) return true;
      } else if (path.startsWith("/api/auth/hosted/") || path === "/pair" || (path === "/" && (!isLoopbackHost(req.headers.host) || isProxied(req)))) {
        json(res, 503, { error: "Workspace sign-in is unavailable." });
        return true;
      }
    }
    // ── who is asking (server/request-auth.ts) ──────────────────────────
    // Two public routes come first: what this server is, and turning a pairing
    // code into a session. Everything else needs the loopback owner or a
    // paired session with the right scope.
    if (method === "GET" && !path.startsWith("/api/") && !path.startsWith("/.well-known/") && serveStatic(res, path)) {
      return true;
    }
    if (method === "GET" && path === "/.well-known/openmausbot/environment") {
      json(res, 200, environmentDescriptor({ environmentId: ENVIRONMENT_ID, desktopManaged: DESKTOP_MANAGED, emailSignIn: !HOSTED_WORKSPACE && emailSignIn.enabled(), sharedComputers: sharedComputersEnabled(cfg) }));
      return true;
    }
    const domainCheck = /^\/\.well-known\/openmausbot\/domain-check\/([a-f0-9]{64})$/.exec(path);
    if (method === "GET" && domainCheck) {
      res.setHeader("cache-control", "no-store");
      const challenge = customDomainVerifier.challenge(domainCheck[1]);
      json(res, challenge ? 200 : 404, challenge ?? { error: "No active domain check." });
      return true;
    }
    // Sign in with an emailed code (server/account-signin.ts). Public like
    // /api/auth/pair, JSON-only for the same reason, and counted against the
    // same per-source lockout so a code cannot be guessed.
    if (method === "POST" && (path === "/api/auth/email/start" || path === "/api/auth/email/verify")) {
      if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) {
        json(res, 415, { error: "send the sign-in request as JSON (content-type: application/json)" });
        return true;
      }
      if (!emailSignIn.enabled()) {
        json(res, 404, { error: "email sign-in is not set up on this server; use a pairing code" });
        return true;
      }
      const source = requestSource(req);
      const allowed = sessions.attemptAllowed(source);
      if (!allowed.ok) {
        json(res, 429, { error: `too many failed sign-in attempts from your address; try again in ${Math.ceil(allowed.retryAfterMs / 1000)}s` });
        return true;
      }
      const body = await readBody(req);
      const email = typeof body?.email === "string" ? body.email : "";
      if (path === "/api/auth/email/start") {
        const started = await emailSignIn.start(email);
        if (!started.ok) {
          if (started.status === 403) sessions.noteFailure(source);
          json(res, started.status, { error: started.error });
          return true;
        }
        json(res, 200, { ok: true });
        return true;
      }
      const code = typeof body?.code === "string" ? body.code : "";
      const label = typeof body?.label === "string" ? body.label : "";
      const verified = await emailSignIn.verify(email, code);
      if (!verified.ok) {
        if (verified.status === 401 || verified.status === 403) sessions.noteFailure(source);
        console.warn(`email sign-in refused from ${source}: ${verified.error}`);
        json(res, verified.status, { error: verified.error });
        return true;
      }
      sessions.clearFailures(source);
      const issued = sessions.issue({ label: label.trim() || labelFromUserAgent(req.headers["user-agent"]), scopes: verified.scopes, userId: verified.userId, email: verified.email });
      const environment = environmentDescriptor({ environmentId: ENVIRONMENT_ID, desktopManaged: DESKTOP_MANAGED, emailSignIn: true, sharedComputers: sharedComputersEnabled(cfg) });
      const secure = requestOrigin(req)?.startsWith("https://") === true;
      res.setHeader("set-cookie", serializeSessionCookie(SESSION_COOKIE, issued.token, { secure, maxAgeSeconds: cookieMaxAgeSeconds(issued.session) }));
      json(res, 200, { session: issued.session, environment });
      return true;
    }
    if (method === "POST" && path === "/api/auth/pair") {
      // JSON only: a cross-site HTML form cannot send this content type
      // without a preflight, so a stray unused code cannot be planted as a
      // session in someone else's browser.
      if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) {
        json(res, 415, { error: "send the pairing code as JSON (content-type: application/json)" });
        return true;
      }
      const body = await readBody(req);
      const code = typeof body?.code === "string" ? body.code : "";
      const wantsCookie = body?.cookie === true;
      const label = typeof body?.label === "string" ? body.label : "";
      const attemptId = typeof body?.attemptId === "string" ? body.attemptId : undefined;
      const result = sessions.exchange({ code, label, attemptId, source: requestSource(req), fallbackLabel: labelFromUserAgent(req.headers["user-agent"]) });
      if (!result.ok) {
        console.warn(`pairing refused from ${requestSource(req)}: ${result.error}`);
        json(res, result.status, { error: result.error });
        return true;
      }
      const environment = environmentDescriptor({ environmentId: ENVIRONMENT_ID, desktopManaged: DESKTOP_MANAGED, emailSignIn: emailSignIn.enabled(), sharedComputers: sharedComputersEnabled(cfg) });
      if (wantsCookie) {
        const secure = requestOrigin(req)?.startsWith("https://") === true;
        res.setHeader("set-cookie", serializeSessionCookie(SESSION_COOKIE, result.token, { secure, maxAgeSeconds: cookieMaxAgeSeconds(result.session) }));
        json(res, 200, { session: result.session, environment });
        return true;
      }
      json(res, 200, { token: result.token, session: result.session, environment });
      return true;
    }
    // The route the iOS and Android companion apps already POST to. Until now
    // only the desktop's companion sidecar answered it, so a self-hosted
    // server had nothing for a native phone to pair against: the app could
    // reach the server and pass its health probe, then ask for a credential
    // the server could not issue. Same window, same lockout and the same
    // single-use exchange as /api/auth/pair above; only the request and
    // response shapes differ, because the apps were written against the
    // sidecar. Public and unauthenticated for the same reason
    // /api/auth/pair is: redeeming a one-time credential IS the sign-in.
    if (method === "POST" && path === "/api/pair") {
      if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) {
        json(res, 415, { error: "send the pairing credential as JSON (content-type: application/json)" });
        return true;
      }
      const body = await readBody(req);
      const credential = typeof body?.credential === "string" ? body.credential : typeof body?.code === "string" ? body.code : "";
      const label = typeof body?.deviceName === "string" ? body.deviceName : "";
      const attemptId = typeof body?.pairRequestId === "string" ? body.pairRequestId : undefined;
      const paired = sessions.exchange({ code: credential, label, attemptId, source: requestSource(req), fallbackLabel: labelFromUserAgent(req.headers["user-agent"]) });
      if (!paired.ok) {
        console.warn(`pairing refused from ${requestSource(req)}: ${paired.error}`);
        json(res, paired.status, { error: paired.error });
        return true;
      }
      // The shape the companion apps decode (android/core Models.kt,
      // PairResponseSerializer): token, device and serverName are required;
      // hosts and endpoints are advisory and deliberately omitted, because a
      // harness has no sidecar endpoints to advertise.
      json(res, 200, {
        token: paired.token,
        device: {
          id: paired.session.id,
          name: paired.session.label,
          createdAt: paired.session.createdAt,
          lastSeenAt: paired.session.lastSeenAt,
        },
        serverName: environmentDescriptor({ environmentId: ENVIRONMENT_ID, desktopManaged: DESKTOP_MANAGED }).label,
      });
      return true;
    }
    return false;
  };
}
