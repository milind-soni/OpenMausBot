// The auth-session HTTP routes (who-am-I, stream tickets, logout, pairing
// open/list/cancel, the custom-domain setting, and the session list with
// revocation), extracted verbatim from index.ts's dispatch chain. Path
// matching, methods, and status codes are unchanged; the handler returns
// false for anything it does not own so the chain falls through in the
// same order. The two halves of this family used to sit either side of
// the shared-computer-control and /api/shared-computers POST blocks,
// which stay in index.ts; those intervening paths (/api/desktop/*,
// /api/shared-computers/*) are disjoint from every path owned here
// (/api/auth/*, /api/settings/custom-domain), so the single earlier call
// site preserves behavior. The pre-auth sign-in routes (email start/
// verify, /api/auth/pair, /api/pair) and the !gate.auth /api/health and
// /api/brand probes stay in index.ts: they run before the auth gate
// resolves. The session registry, cookie name, verifier and domain
// helpers are index-local and cross via deps; the customDomainRevision
// counter moved in with the only block that reads and writes it;
// ENVIRONMENT_ID and cfg are live bindings from ../runtime.ts.
import type { IncomingMessage, ServerResponse } from "node:http";

import { json, readBody, type RouteContext } from "./http.ts";
import { cfg, ENVIRONMENT_ID } from "../runtime.ts";
import { saveConfig } from "../config.ts";
import { formatPairingCode, type Scope, type SessionRegistry } from "../sessions.ts";
import { clearSessionCookie, requestOrigin } from "../request-auth.ts";
import { environmentDescriptor } from "../environment.ts";
import type { createCustomDomainVerifier } from "../custom-domain.ts";

type CustomDomainVerifier = ReturnType<typeof createCustomDomainVerifier>;
type CustomDomainStatus = {
  customDomain: string | null;
  publicUrl: string | null;
  fallbackUrl: string | null;
  supported: boolean;
  appPort: number;
  webhookPort: number;
  serverIpv4: string | null;
};

export function createAuthSessionRoutes(deps: {
  sessions: SessionRegistry;
  SESSION_COOKIE: string;
  DESKTOP_MANAGED: boolean;
  publicUrl: () => string | null;
  customDomainStatus: () => CustomDomainStatus;
  customDomainVerifier: CustomDomainVerifier;
}) {
  return async (req: IncomingMessage, res: ServerResponse, rctx: RouteContext): Promise<boolean> => {
    const { method, path, auth } = rctx;
    /** scratch for route matches, shared by every `path.match` below */
    let m: RegExpMatchArray | null = null;
    const {
      sessions,
      SESSION_COOKIE,
      DESKTOP_MANAGED,
      publicUrl,
      customDomainStatus,
      customDomainVerifier,
    } = deps;
    /** revision of saved custom-domain edits; guards verify against races */
    let customDomainRevision = 0;
    // ── sessions: who am I, tickets, pairing and revocation ─────────────
    if (method === "GET" && path === "/api/auth/session") {
      json(
        res,
        200,
        auth.kind === "loopback"
          ? { kind: "loopback", scopes: auth.scopes, environmentId: ENVIRONMENT_ID }
          : {
              kind: "session",
              id: auth.session.id,
              label: auth.session.label,
              scopes: auth.scopes,
              expiresAt: auth.session.expiresAt,
              via: auth.via,
              environmentId: ENVIRONMENT_ID,
              // the account behind the session, when it came from a sign-in
              ...(auth.session.email ? { email: auth.session.email } : {}),
            },
      );
      return true;
    }
    if (method === "POST" && path === "/api/auth/stream-ticket") {
      if (auth.kind === "loopback") {
        json(res, 200, { ticket: null, reason: "loopback needs no ticket" });
        return true;
      }
      json(res, 200, sessions.issueStreamTicket(auth.session.id));
      return true;
    }
    if (method === "POST" && path === "/api/auth/logout") {
      if (auth.kind === "session") sessions.revoke(auth.session.id);
      res.setHeader("set-cookie", clearSessionCookie(SESSION_COOKIE));
      json(res, 200, { ok: true });
      return true;
    }
    if (method === "POST" && path === "/api/auth/pairing") {
      const body = await readBody(req);
      // Authentication happened before the request body was read. A session
      // can be revoked while a slow client is still sending that body, so do
      // not let the captured authorization mint a replacement session.
      if (auth.kind === "session" && !sessions.isLive(auth.session.id)) {
        json(res, 401, { error: "Your session ended. Sign in again before creating a pairing code." });
        return true;
      }
      const requested: unknown = body?.scopes;
      const scopes = Array.isArray(requested) ? requested.filter((v): v is Scope => v === "admin" || v === "client") : undefined;
      const opened = sessions.openPairing({ label: typeof body?.label === "string" ? body.label : undefined, scopes });
      const origin = requestOrigin(req);
      const base = publicUrl() ?? (auth.kind === "session" && origin ? origin : null);
      const code = formatPairingCode(opened.code);
      // Two links for one window. `url` opens the web app and is what a
      // browser and the iOS app already read. `inviteUrl` is the custom
      // scheme the native companion scanners accept; it carries the
      // credential encoding because those scanners cannot take a typed code.
      const serverName = environmentDescriptor({ environmentId: ENVIRONMENT_ID, desktopManaged: DESKTOP_MANAGED }).label;
      const invite = base
        ? `openmausbot://pair?address=${encodeURIComponent(base)}&token=${encodeURIComponent(opened.credential)}&name=${encodeURIComponent(serverName)}`
        : null;
      json(res, 200, {
        id: opened.id,
        code,
        credential: opened.credential,
        expiresAt: opened.expiresAt,
        url: base ? `${base}/pair#code=${code}` : null,
        inviteUrl: invite,
        serverName,
        hint: base
          ? null
          : "this server has no public address to put in a link: set OMB_PUBLIC_URL, or open /pair on the address you use and type the code",
      });
      return true;
    }
    if (method === "GET" && path === "/api/auth/pairing") {
      json(res, 200, { pairings: sessions.openPairings(), publicUrl: publicUrl() });
      return true;
    }
    // Admin-only via request-auth's default deny. Connecting a domain only
    // changes future pairing links; DNS, proxy setup, webhooks and all existing
    // sessions remain untouched. The tunnel/deployment URL is kept as fallback.
    if (path === "/api/settings/custom-domain") {
      res.setHeader("cache-control", "no-store");
      if (method === "GET") {
        json(res, 200, customDomainStatus());
        return true;
      }
      if (method === "POST" || method === "DELETE") {
        if (DESKTOP_MANAGED) {
          json(res, 409, { error: "Custom domains are configured on a self-hosted OpenMausBot server, not the desktop companion." });
          return true;
        }
        if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) {
          json(res, 415, { error: "content-type must be application/json" });
          return true;
        }
        if (method === "DELETE") {
          saveConfig({ customDomain: "" });
          cfg.customDomain = "";
          customDomainRevision++;
          json(res, 200, customDomainStatus());
          return true;
        }
        const body = await readBody(req, 4096);
        if (typeof body?.domain !== "string") {
          json(res, 400, { error: "Enter your domain name." });
          return true;
        }
        const revision = customDomainRevision;
        const verified = await customDomainVerifier.verify(body.domain);
        if (auth.kind === "session" && !sessions.isLive(auth.session.id)) {
          json(res, 401, { error: "Your session ended. Sign in again before connecting a domain." });
          return true;
        }
        if (revision !== customDomainRevision) {
          json(res, 409, { error: "Domain settings changed during verification. Try again." });
          return true;
        }
        saveConfig({ customDomain: verified.origin });
        cfg.customDomain = verified.origin;
        customDomainRevision++;
        json(res, 200, customDomainStatus());
        return true;
      }
    }
    m = path.match(/^\/api\/auth\/pairing\/([\w-]+)$/);
    if (m && method === "DELETE") {
      const cancelled = sessions.cancelPairing(m[1]);
      json(res, cancelled ? 200 : 404, cancelled ? { ok: true } : { error: "no such pairing code" });
      return true;
    }

    if (method === "GET" && path === "/api/auth/sessions") {
      json(res, 200, { sessions: sessions.list(), current: auth.kind === "session" ? auth.session.id : null });
      return true;
    }
    m = path.match(/^\/api\/auth\/sessions\/([\w-]+)$/);
    if (m && method === "DELETE") {
      const revoked = sessions.revoke(m[1]);
      if (auth.kind === "session" && auth.session.id === m[1]) res.setHeader("set-cookie", clearSessionCookie(SESSION_COOKIE));
      json(res, revoked ? 200 : 404, revoked ? { ok: true } : { error: "no such session" });
      return true;
    }
    return false;
  };
}
