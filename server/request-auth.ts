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
import { denyReason as companionDenial } from "../companion/src/routes.ts";

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
  return ipcPeer(req) || Boolean(h["x-forwarded-for"] || h["x-forwarded-proto"] || h["x-forwarded-host"] || h["forwarded"]);
}

/** A request over an IPC listener (a unix socket or a named pipe) has no peer
 * address. Only a gateway on this machine can reach such a listener, and it
 * is there to forward traffic from elsewhere (`openmausbot serve --tunnel`),
 * so the request is remote by construction: whatever headers it carries or
 * lacks, it never gets loopback trust. */
export function ipcPeer(req: IncomingMessage): boolean {
  const socket = req.socket;
  return Boolean(socket) && socket.remoteAddress === undefined && socket.remoteFamily === undefined;
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
  // An IPC listener's only peer is the tunnel gateway on this machine.
  const viaLocalProxy = ipcPeer(req) || peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
  // The LAST hop is the one the adjacent (trusted, same-machine) proxy wrote;
  // earlier hops are whatever the client or an outer proxy put there.
  const hops = viaLocalProxy ? (headerValue(req.headers["x-forwarded-for"]) ?? "").split(",").map((h) => h.trim()).filter(Boolean) : [];
  const forwarded = hops.length ? hops[hops.length - 1] : undefined;
  return sanitizeSource(forwarded || peer);
}

/** Only what an address can contain, bounded, so a hostile header cannot
 * carry control characters into logs or grow the lockout map without limit. */
export function sanitizeSource(value: string): string {
  const clean = value.replace(/[^\w.:%[\]-]/g, "");
  return (clean || "unknown").slice(0, 64);
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

/** What a `client` session may do: chat, rooms, approvals, attachments,
 * routines, its own session, and reads that carry no secrets. Everything
 * else needs `admin`: default deny, so a new route is admin-only until it is
 * deliberately listed here. Two client-allowed PATCH routes carry a body
 * filter in the handler (bot and room edits: display fields only). Loopback
 * holds both scopes. */
export const CLIENT_ALLOW: ReadonlyArray<{ methods: readonly string[]; path: RegExp }> = [
  // own session
  { methods: ["GET"], path: /^\/api\/auth\/session$/ },
  { methods: ["POST"], path: /^\/api\/auth\/stream-ticket$/ },
  { methods: ["POST"], path: /^\/api\/auth\/logout$/ },
  // liveness, identity, the stream
  { methods: ["GET"], path: /^\/api\/health$/ },
  { methods: ["GET"], path: /^\/api\/edition$/ },
  { methods: ["GET"], path: /^\/api\/brand$/ },
  { methods: ["GET"], path: /^\/api\/events$/ },
  // reads: fleet, transcripts, search (no secrets in any of these)
  { methods: ["GET"], path: /^\/api\/bots$/ },
  { methods: ["GET"], path: /^\/api\/team-map$/ },
  { methods: ["GET"], path: /^\/api\/search$/ },
  { methods: ["GET"], path: /^\/api\/threads\/[\w-]+\/messages$/ },
  { methods: ["GET"], path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/image$/ },
  { methods: ["GET"], path: /^\/api\/threads\/[\w-]+\/export$/ },
  { methods: ["POST"], path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/file$/ },
  // chat, one to one
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/messages$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/messages\/[\w-]+\/edit$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/active-branch$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/interrupt$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/read$/ },
  { methods: ["DELETE"], path: /^\/api\/bots\/[\w-]+\/queue\/[\w-]+$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/tasks$/ },
  { methods: ["POST", "PATCH", "DELETE"], path: /^\/api\/bots\/[\w-]+\/tasks\/[\w-]+$/ },
  { methods: ["PATCH"], path: /^\/api\/bots\/[\w-]+\/profile$/ },
  { methods: ["PATCH"], path: /^\/api\/bots\/[\w-]+$/ }, // display fields only: see clientBotPatchViolation
  // approvals and cards
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/respond$/ },
  { methods: ["POST"], path: /^\/api\/threads\/[\w-]+\/respond$/ },
  { methods: ["PATCH"], path: /^\/api\/bots\/[\w-]+\/cards\/[\w-]+$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/secret-cards\/[\w-]+\/(?:resume|dismiss)$/ },
  { methods: ["GET"], path: /^\/api\/bots\/[\w-]+\/connector-cards\/[\w-]+\/status$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/connector-cards\/[\w-]+\/(?:resume|dismiss)$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/always-allow$/ }, // must match a pending card
  // rooms
  { methods: ["POST"], path: /^\/api\/groups$/ },
  { methods: ["POST"], path: /^\/api\/groups\/[\w-]+\/messages$/ },
  { methods: ["POST"], path: /^\/api\/groups\/[\w-]+\/interrupt$/ },
  { methods: ["POST"], path: /^\/api\/groups\/[\w-]+\/read$/ },
  { methods: ["DELETE"], path: /^\/api\/groups\/[\w-]+\/queue\/[\w-]+$/ },
  { methods: ["POST"], path: /^\/api\/groups\/[\w-]+\/tasks$/ },
  { methods: ["POST", "PATCH", "DELETE"], path: /^\/api\/groups\/[\w-]+\/tasks\/[\w-]+$/ },
  { methods: ["PATCH"], path: /^\/api\/groups\/[\w-]+$/ }, // display fields only: see clientGroupPatchViolation
  { methods: ["POST"], path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/reactions$/ },
  // attachments
  { methods: ["POST"], path: /^\/api\/attachments$/ },
  { methods: ["GET"], path: /^\/api\/attachments\/[\w.-]+$/ },
  { methods: ["POST"], path: /^\/api\/files$/ },
  // voice: labels and audio, never the key
  { methods: ["GET"], path: /^\/api\/tts\/voices$/ },
  { methods: ["POST"], path: /^\/api\/tts\/prepare$/ },
  { methods: ["POST"], path: /^\/api\/tts\/speak$/ },
  // routines: a scheduled message; the input carries no cwd or permission field
  { methods: ["GET"], path: /^\/api\/routines$/ },
  { methods: ["POST"], path: /^\/api\/routines$/ },
  { methods: ["PATCH", "DELETE"], path: /^\/api\/routines\/[\w-]+$/ },
  { methods: ["POST"], path: /^\/api\/routines\/[\w-]+\/run$/ },
  { methods: ["POST"], path: /^\/api\/routine-runs\/[\w-]+\/(?:cancel|seen)$/ },
  // webhook list is secret-free; creating or rotating one is not
  { methods: ["GET"], path: /^\/api\/webhooks$/ },
  // configured-or-not booleans; the handler strips the few identifying fields for clients
  { methods: ["GET"], path: /^\/api\/config$/ },
];

export function requiredScope(method: string, path: string): Scope {
  const upper = method.toUpperCase();
  for (const rule of CLIENT_ALLOW) {
    if (rule.path.test(path) && rule.methods.includes(upper)) return "client";
  }
  return "admin";
}

/** Fields a client session may change on a bot: how it looks in the list,
 * never what it may do. Returns the first offending field, or null. */
const CLIENT_BOT_PATCH_FIELDS = new Set(["unread", "pinned", "pinnedMessageId", "color", "mascotExpression", "mascotBody"]);
export function clientBotPatchViolation(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "body";
  for (const key of Object.keys(body)) if (!CLIENT_BOT_PATCH_FIELDS.has(key)) return key;
  return null;
}

/** Same for a room: name and reading state, never its folder or who answers. */
const CLIENT_GROUP_PATCH_FIELDS = new Set(["name", "bulletin", "unread", "pinnedMessageId", "section"]);
export function clientGroupPatchViolation(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "body";
  for (const key of Object.keys(body)) if (!CLIENT_GROUP_PATCH_FIELDS.has(key)) return key;
  return null;
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
  /** Separate private capability held by the authenticated phone relay. */
  companionMutationToken?: string;
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
    const companionToken = headerValue(req.headers["x-openmausbot-companion-auth"]);
    if (companionToken && options.loopbackMutationToken !== undefined) {
      if (
        !secureTokenMatch(companionToken, options.companionMutationToken ?? "") ||
        req.headers["x-openmausbot-companion"] !== "1" ||
        !/^[\w-]{1,128}$/.test(headerValue(req.headers["x-openmausbot-companion-device"]) ?? "") ||
        companionDenial({ path, method, authenticated: true })
      ) return deny(403, "forbidden: invalid companion request");
      return { auth: { kind: "loopback", scopes: LOOPBACK_SCOPES }, status: 401, error: "" };
    }
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
