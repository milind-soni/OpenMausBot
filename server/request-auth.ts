// Who is asking, and are they allowed to?
//
// Two ways in. A **loopback** request (Host and Origin both loopback) may read
// local state; packaged mutations additionally carry a per-launch capability
// injected by Electron below renderer JavaScript. A **session** request carries
// a credential minted by pairing
// (server/sessions.ts): a bearer token, the session cookie the served web UI
// uses, or, for the event stream only, a short-lived ticket. With a session
// the loopback rule is replaced by a same-origin rule, so a browser on
// another site still cannot ride the cookie (CSRF), and by a scope check.
import type { IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import type { Scope, SessionRecord, SessionRegistry } from "./sessions.ts";

export type RequestAuth =
  | { kind: "loopback"; scopes: readonly Scope[] }
  | { kind: "session"; session: SessionRecord; via: "bearer" | "cookie" | "ticket"; scopes: readonly Scope[] };

export interface RequestAuthResult {
  auth: RequestAuth | null;
  /** HTTP status and the reason to send when auth is null. */
  status: 401 | 403;
  error: string;
}

const LOOPBACK_SCOPES: readonly Scope[] = ["admin", "client"];

export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const value = host.trim().toLowerCase();
  if (!value) return false;

  let hostname = value;
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close < 0 || (value.length > close + 1 && !/^:\d+$/.test(value.slice(close + 1)))) return false;
    hostname = value.slice(1, close);
  } else {
    const firstColon = value.indexOf(":");
    const lastColon = value.lastIndexOf(":");
    if (firstColon >= 0 && firstColon === lastColon) {
      if (!/^\d+$/.test(value.slice(firstColon + 1))) return false;
      hostname = value.slice(0, firstColon);
    }
  }

  if (hostname === "localhost" || hostname === "localhost.") return true;
  if (isIP(hostname) === 4) return hostname.startsWith("127.");
  return hostname === "::1" || hostname === "0:0:0:0:0:0:0:1";
}

export function isAllowedOrigin(origin: string | undefined | null): boolean {
  if (!origin) return true; // non-browser clients (CLIs, curl, tests) send none
  try {
    const o = new URL(origin);
    return isLoopbackHost(o.hostname) && (o.protocol === "http:" || o.protocol === "https:");
  } catch {
    return false;
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The origin a browser would send for this request: the proxy's scheme
 * when one says so (x-forwarded-proto), else plain http, plus the Host. */
export function requestOrigin(req: IncomingMessage): string | null {
  const host = headerValue(req.headers.host)?.trim();
  if (!host) return null;
  const forwarded = headerValue(req.headers["x-forwarded-proto"])?.split(",")[0]?.trim().toLowerCase();
  const proto = forwarded === "https" || forwarded === "http" ? forwarded : "http";
  return `${proto}://${host.toLowerCase()}`;
}

/** A proxy on the way in sets forwarded headers; a client on this machine
 * does not. Loopback trust is for the latter only: a proxy that hands the
 * server a loopback Host (or forwards `Host: localhost` from a stranger)
 * must not turn a remote client into the owner. */
export function isProxied(req: IncomingMessage): boolean {
  const h = req.headers;
  return Boolean(h["x-forwarded-for"] || h["x-forwarded-proto"] || h["x-forwarded-host"] || h["forwarded"]);
}

/** Origin absent (non-browser) or equal to this request's own origin. */
export function isSameOrigin(req: IncomingMessage): boolean {
  const origin = headerValue(req.headers.origin);
  if (!origin) return true;
  const own = requestOrigin(req);
  return own !== null && origin.trim().toLowerCase() === own;
}

/** Who to count a pairing attempt against. The server binds loopback, so a
 * remote client always arrives through a proxy or tunnel on this machine;
 * that proxy's X-Forwarded-For (Caddy overwrites any the client sent) names
 * the real source. A connection whose peer is not loopback (a future bind to
 * an interface) is the source itself, and its forwarded header is ignored. */
export function requestSource(req: IncomingMessage): string {
  const peer = req.socket?.remoteAddress || "unknown";
  const viaLocalProxy = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
  const forwarded = viaLocalProxy ? headerValue(req.headers["x-forwarded-for"])?.split(",")[0]?.trim() : undefined;
  return forwarded || peer;
}

/** "Safari on iPhone" beats "Unnamed device" in the sessions list. */
export function labelFromUserAgent(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  if (!ua) return "Unnamed device";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : /curl\//.test(ua) ? "curl" : "Client";
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    out.set(name, part.slice(eq + 1).trim());
  }
  return out;
}

export function bearerToken(header: string | string[] | undefined): string | undefined {
  const value = headerValue(header);
  if (!value) return undefined;
  const m = /^Bearer\s+(\S+)$/i.exec(value.trim());
  return m?.[1];
}

/** Cookies are scoped by host, not port: two servers on one machine would
 * otherwise clobber each other's session. The environment id keeps a
 * reinstalled server from reading a cookie signed by its predecessor. */
export function sessionCookieName(port: number, environmentId: string): string {
  return `omb_session_${port}_${environmentId.replace(/[^a-z0-9]/gi, "").slice(0, 12)}`;
}

export function serializeSessionCookie(
  name: string,
  token: string,
  options: { secure: boolean; maxAgeSeconds: number },
): string {
  const parts = [`${name}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${options.maxAgeSeconds}`];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** Route → scope. Anything not listed needs `client`, which every session has;
 * the listed routes change who can get in or what the server runs, so they
 * need `admin`. Loopback holds both scopes, while packaged loopback mutations
 * separately prove the private desktop capability below. Keep this table next
 * to the routes it names when adding one. */
const ADMIN_ROUTES: ReadonlyArray<{ methods: readonly string[] | null; path: RegExp }> = [
  { methods: null, path: /^\/api\/auth\/pairing(\/|$)/ },
  { methods: null, path: /^\/api\/auth\/sessions(\/|$)/ },
  { methods: ["PUT", "PATCH", "DELETE"], path: /^\/api\/config$/ },
  { methods: ["POST", "PUT", "PATCH", "DELETE"], path: /^\/api\/(instances|engines|mcp-servers|mcp\/servers|custom-engines)(\/|$)/ },
  { methods: ["POST"], path: /^\/api\/computers\/(boxes|vps)(\/|$)/ },
];

export function requiredScope(method: string, path: string): Scope {
  const upper = method.toUpperCase();
  for (const rule of ADMIN_ROUTES) {
    if (rule.path.test(path) && (rule.methods === null || rule.methods.includes(upper))) return "admin";
  }
  return "client";
}

export interface ResolveOptions {
  sessions: SessionRegistry;
  cookieName: string;
  /** Path that may authenticate with a stream ticket in its query string. */
  streamPath: string;
  url: URL;
  /** Packaged desktop capability, delivered over Electron's private child
   * port. When present, originless loopback callers may still read but every
   * public mutation must prove it came through the desktop's web session. */
  loopbackMutationToken?: string;
}

const DESKTOP_OWNER_HEADER = "x-openmausbot-desktop-owner";

function mutatingPublicRoute(method: string, path: string): boolean {
  const upper = method.toUpperCase();
  // This legacy polling endpoint is spelled GET but synchronizes upstream
  // state into the transcript and can resume a paused turn. Classify by
  // effect, not verb, until clients migrate to a POST refresh route.
  if (
    upper === "GET" &&
    /^\/api\/bots\/[\w-]+\/connector-cards\/[\w-]+\/status$/.test(path)
  ) return true;
  if (["GET", "HEAD", "OPTIONS"].includes(upper)) return false;
  // Agent integrations have their own high-entropy, per-boot authorization
  // and narrower route semantics. Pairing-code exchange is intentionally
  // public; possession of the one-time code is its authorization.
  return !path.startsWith("/api/internal/") &&
    path !== "/api/testing/internal-capability" &&
    path !== "/api/auth/pair";
}

function secureTokenMatch(actual: string | undefined, expected: string): boolean {
  if (!actual || !expected) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Decide how this request is authenticated. Never throws. */
export function resolveRequestAuth(req: IncomingMessage, options: ResolveOptions): RequestAuthResult {
  const method = req.method ?? "GET";
  const path = options.url.pathname;
  const deny = (status: 401 | 403, error: string): RequestAuthResult => ({ auth: null, status, error });

  // A presented session credential wins over the loopback rule so the served
  // web UI behaves the same on 127.0.0.1 and on a public domain.
  const bearer = bearerToken(req.headers.authorization);
  const cookie = parseCookies(headerValue(req.headers.cookie)).get(options.cookieName);
  const ticket = path === options.streamPath ? options.url.searchParams.get("ticket") : null;
  let session: SessionRecord | null = null;
  let via: "bearer" | "cookie" | "ticket" | null = null;
  if (bearer?.startsWith("omb_sess_")) {
    session = options.sessions.authenticate(bearer);
    via = "bearer";
  } else if (ticket) {
    session = options.sessions.redeemStreamTicket(ticket);
    via = "ticket";
  } else if (cookie) {
    session = options.sessions.authenticate(cookie);
    via = "cookie";
  }

  if (session && via) {
    if (via === "cookie" && !isSameOrigin(req)) return deny(403, "forbidden: cross-origin request");
    const needed = requiredScope(method, path);
    if (!session.scopes.includes(needed)) {
      return deny(403, `forbidden: this session lacks the ${needed} scope`);
    }
    return { auth: { kind: "session", session, via, scopes: session.scopes }, status: 401, error: "" };
  }

  const proxied = isProxied(req);
  const loopback = !proxied && isLoopbackHost(headerValue(req.headers.host)) && isAllowedOrigin(headerValue(req.headers.origin));
  if (loopback) {
    if (
      options.loopbackMutationToken !== undefined &&
      mutatingPublicRoute(method, path) &&
      !secureTokenMatch(headerValue(req.headers[DESKTOP_OWNER_HEADER]), options.loopbackMutationToken)
    ) {
      return deny(403, "forbidden: this change must come from the desktop app or a paired device");
    }
    return { auth: { kind: "loopback", scopes: LOOPBACK_SCOPES }, status: 401, error: "" };
  }

  if (via) {
    return deny(401, "unauthorized: this session has expired or was revoked; pair this device again");
  }
  if (proxied) {
    return deny(403, "forbidden: this request came through a proxy (pair this device to use the server remotely)");
  }
  if (!isLoopbackHost(headerValue(req.headers.host))) {
    return deny(403, "forbidden: loopback host required (pair this device to use the server remotely)");
  }
  return deny(403, "forbidden: cross-origin request");
}
