// Hosted workspace access is opt-in. The portal proves identity/membership;
// the local email allow-list remains an independent, narrowing check.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WorkspaceAccess, WorkspaceAccessOptions } from "../../server/enterprise.ts";
import { isAllowedOrigin, isLoopbackHost, isProxied, parseCookies, serializeSessionCookie } from "../../server/request-auth.ts";
import { cookieMaxAgeSeconds, type Scope, type SessionRecord } from "../../server/sessions.ts";

const START = "/api/auth/hosted/start";
const CALLBACK = "/api/auth/hosted/callback";
const TTL_MS = 300_000;
const PROOF = /^[A-Za-z0-9_-]{43}$/;
const unavailable = { status: 503 as const, error: "Workspace sign-in is unavailable. Try again shortly." };
const denied = { status: 401 as const, error: "Workspace access ended. Sign in again." };

function httpsOrigin(raw: string | undefined): URL {
  if (!raw || raw !== raw.trim()) throw new Error("missing origin");
  const url = new URL(raw);
  if (url.protocol !== "https:" || (raw !== url.origin && raw !== `${url.origin}/`)) throw new Error("invalid origin");
  return url;
}

function equal(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function identity(value: unknown): { email: string; scopes: Scope[] } | null {
  if (!value || typeof value !== "object") return null;
  const { email, role } = value as Record<string, unknown>;
  if (typeof email !== "string" || email.length > 320 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null;
  if (role !== "admin" && role !== "member") return null;
  return { email: email.toLowerCase(), scopes: role === "admin" ? ["admin", "client"] : ["client"] };
}

export function createWorkspaceAccess(options: WorkspaceAccessOptions): WorkspaceAccess {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;
  let config: { admin: URL; tenant: URL; workspace: string } | null = null;
  try {
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(env.OMB_ADMIN_WORKSPACE ?? "")) throw new Error("invalid workspace");
    config = { admin: httpsOrigin(env.OMB_ADMIN_URL), tenant: httpsOrigin(env.OMB_PUBLIC_URL), workspace: env.OMB_ADMIN_WORKSPACE! };
  } catch { /* A partially configured hosted server is never legacy mode. */ }
  const cookieName = `__Host-${options.cookieName}_handoff`;
  const pending = new Map<string, { verifier: string; expiresAt: number }>();
  const observed = new Map<string, SessionRecord>();
  let checking = false;

  const clearCookie = () => serializeSessionCookie(cookieName, "", { secure: true, maxAgeSeconds: 0 });
  const tenantHost = (req: IncomingMessage) => config !== null && req.headers.host?.toLowerCase() === config.tenant.host;
  const localOwner = (req: IncomingMessage) => !isProxied(req) && isLoopbackHost(req.headers.host) && isAllowedOrigin(typeof req.headers.origin === "string" ? req.headers.origin : undefined);
  const redirect = (res: ServerResponse, to: string) => { res.writeHead(302, { location: to, "cache-control": "no-store", "referrer-policy": "no-referrer" }); res.end(); };
  const failurePage = (res: ServerResponse, status: number) => {
    res.setHeader("set-cookie", clearCookie());
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" });
    res.end(`<!doctype html><title>Workspace sign-in</title><p>Workspace sign-in could not finish.</p><a href="${START}">Try signing in again</a>`);
  };
  const post = async (path: string, body: object) => {
    if (!config || !options.entitled()) return { status: 503, body: null };
    try {
      const response = await fetchImpl(new URL(path, config.admin), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace: config.workspace, ...body }),
        credentials: "omit", redirect: "error", signal: AbortSignal.timeout(5_000),
      });
      const responseBody = response.ok ? await response.json() as unknown : null;
      return options.entitled() ? { status: response.status, body: responseBody } : { status: 503, body: null };
    } catch { return { status: 503, body: null }; }
  };
  const check = async (session: SessionRecord) => {
    if (!options.sessions.isLive(session.id)) { observed.delete(session.id); return denied; }
    const result = await post("/api/handoff/check", { grant: session.userId!.slice("portal:".length) });
    if (result.status !== 200 && result.status !== 401) {
      options.closeSessionStreams(session.id);
      return unavailable; // outage is not permanent membership removal
    }
    const current = identity(result.body);
    if (!current || current.email !== session.email?.toLowerCase() || session.scopes.some((scope) => !current.scopes.includes(scope))) {
      options.sessions.revoke(session.id);
      observed.delete(session.id);
      return denied;
    }
    return options.sessions.isLive(session.id) ? null : denied;
  };

  const access: WorkspaceAccess = {
    async handlePublic(req, res, url) {
      const path = url.pathname;
      if (req.method !== "GET" || !["/", "/pair", START, CALLBACK].includes(path)) return false;
      if ((path === "/" || path === "/pair") && localOwner(req)) return false;
      if (!config || !options.entitled()) { failurePage(res, 503); return true; }
      if (!tenantHost(req)) { failurePage(res, 403); return true; }
      if (path === "/pair") { redirect(res, START); return true; }
      if (path === "/") {
        const token = parseCookies(req.headers.cookie).get(options.cookieName);
        const session = options.sessions.authenticate(token);
        if (session) {
          const failure = await access.authorize(req, { kind: "session", session, scopes: session.scopes, via: "cookie" });
          if (!failure) return false;
          if (failure.status === 503) { failurePage(res, 503); return true; }
        }
        redirect(res, START); return true;
      }
      if (path === START) {
        for (const [state, value] of pending) if (value.expiresAt <= now()) pending.delete(state);
        // Bounded anonymous handoffs; restarting the server cancels these too.
        if (pending.size >= 1_000) pending.delete(pending.keys().next().value!);
        const state = randomBytes(32).toString("base64url");
        const verifier = randomBytes(32).toString("base64url");
        pending.set(state, { verifier, expiresAt: now() + TTL_MS });
        res.setHeader("set-cookie", serializeSessionCookie(cookieName, `${state}.${verifier}`, { secure: true, maxAgeSeconds: TTL_MS / 1_000 }));
        const target = new URL("/connect", config.admin);
        target.search = new URLSearchParams({ workspace: config.workspace, state, challenge: createHash("sha256").update(verifier).digest("base64url") }).toString();
        redirect(res, target.href); return true;
      }
      const state = url.searchParams.get("state") ?? "";
      const code = url.searchParams.get("code") ?? "";
      const saved = pending.get(state);
      const cookie = parseCookies(req.headers.cookie).get(cookieName) ?? "";
      if (!saved || saved.expiresAt <= now() || !equal(cookie, `${state}.${saved.verifier}`)
        || !PROOF.test(code) || url.searchParams.getAll("state").length !== 1 || url.searchParams.getAll("code").length !== 1) {
        failurePage(res, 400); return true;
      }
      pending.delete(state); // consume before the backchannel await, including failures
      res.setHeader("set-cookie", clearCookie());
      const result = await post("/api/handoff/consume", { code, verifier: saved.verifier });
      const user = identity(result.body);
      const grant = result.body && typeof result.body === "object" ? Reflect.get(result.body, "grant") : null;
      if (result.status !== 200 || !user || typeof grant !== "string" || !PROOF.test(grant)) {
        failurePage(res, result.status === 401 ? 401 : 503); return true;
      }
      const issued = options.sessions.issue({ label: "Hosted workspace", email: user.email, userId: `portal:${grant}`, scopes: user.scopes });
      // Fleet acceptance must have installed this email/role locally too.
      if (!options.sessions.authenticate(issued.token)) { failurePage(res, 403); return true; }
      res.setHeader("set-cookie", [clearCookie(), serializeSessionCookie(options.cookieName, issued.token, { secure: true, maxAgeSeconds: cookieMaxAgeSeconds(issued.session) })]);
      redirect(res, "/"); return true;
    },
    async authorize(req, auth) {
      if (auth.kind === "loopback") return null;
      if (!config || !options.entitled()) return unavailable;
      if (!tenantHost(req)) return { status: 403, error: "Use the configured workspace address." };
      if (!auth.session.userId?.startsWith("portal:") || auth.session.userId.length <= "portal:".length) return denied;
      observed.set(auth.session.id, auth.session);
      return check(auth.session);
    },
    async revalidate() {
      if (checking) return;
      checking = true;
      try { await Promise.all([...observed.values()].map(check)); }
      finally { checking = false; }
    },
  };
  return access;
}
