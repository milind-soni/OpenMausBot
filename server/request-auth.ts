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
 * when one says so (x-forwarded-proto), else plain http, plus the public
 * host. Prefer x-forwarded-host when a trusted adjacent proxy set it — Host
 * alone is often the loopback/upstream target behind Vercel→nginx (or any
 * reverse proxy), which would make same-origin cookie checks fail against a
 * browser Origin on the public site. */
export function requestOrigin(req: IncomingMessage): string | null {
  const forwardedHost = headerValue(req.headers["x-forwarded-host"])?.split(",")[0]?.trim();
  const host = (forwardedHost || headerValue(req.headers.host))?.trim();
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

/** Origin absent (non-browser), equal to this request's own origin, or a
 * trusted front-end origin (see trustedOrigin). */
export function isSameOrigin(req: IncomingMessage, env: NodeJS.ProcessEnv = process.env): boolean {
  const origin = headerValue(req.headers.origin);
  if (!origin) return true;
  const own = requestOrigin(req);
  if (own !== null && origin.trim().toLowerCase() === own) return true;
  return trustedOrigin(origin, env);
}

// Front ends that serve this server's API from their own origin through a
// rewrite proxy (the web app on Vercel: /swarm/api/* -> this server). The
// browser's Origin is then the front end's, while Host is the backend's, so
// the plain same-origin rule would refuse every credentialed write.
//
//   NATION_TRUSTED_ORIGINS          exact https origins, comma-separated
//                                   e.g. https://thenation.city
//   NATION_TRUSTED_ORIGIN_PATTERNS  https origins with ONE "*" inside the
//                                   first host label, between a literal
//                                   prefix and suffix, e.g.
//                                   https://nation-team-chat-*-aurk1.vercel.app
//
// A bare "*", a wildcard spanning labels ("*.vercel.app"), a label that is
// only a wildcard, http, ports and paths are all rejected, so this can never
// open up arbitrary vercel.app (or any other shared-host) origins.
const policyCache = new Map<string, { exact: Set<string>; patterns: RegExp[] }>();
const LABEL_LITERAL = /^[a-z0-9-]+$/;

export function trustedOriginPolicy(env: NodeJS.ProcessEnv = process.env): { exact: Set<string>; patterns: RegExp[] } {
  const exactRaw = env.NATION_TRUSTED_ORIGINS ?? "";
  const patternRaw = env.NATION_TRUSTED_ORIGIN_PATTERNS ?? "";
  const key = `${exactRaw}\n${patternRaw}`;
  const cached = policyCache.get(key);
  if (cached) return cached;
  const exact = new Set<string>();
  for (const entry of exactRaw.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean)) {
    const origin = exactHttpsOrigin(entry);
    if (origin) exact.add(origin);
    else console.warn(`[auth] ignoring NATION_TRUSTED_ORIGINS entry ${JSON.stringify(entry.slice(0, 80))}: not an exact https origin`);
  }
  const patterns: RegExp[] = [];
  for (const entry of patternRaw.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean)) {
    const pattern = originPattern(entry);
    if (pattern) patterns.push(pattern);
    else console.warn(`[auth] ignoring NATION_TRUSTED_ORIGIN_PATTERNS entry ${JSON.stringify(entry.slice(0, 80))}: needs https://prefix-*-suffix.domain`);
  }
  const policy = { exact, patterns };
  policyCache.set(key, policy);
  return policy;
}

export function trustedOrigin(origin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const normalized = exactHttpsOrigin(origin.trim().toLowerCase());
  if (!normalized) return false;
  const policy = trustedOriginPolicy(env);
  return policy.exact.has(normalized) || policy.patterns.some((pattern) => pattern.test(normalized));
}

function exactHttpsOrigin(value: string): string | null {
  if (!/^https:\/\/[a-z0-9.-]+$/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.port || url.username || url.password || url.origin !== value) return null;
    const labels = url.hostname.split(".");
    if (labels.length < 2 || labels.some((label) => !label || !LABEL_LITERAL.test(label) || label.length > 63)) return null;
    return value;
  } catch {
    return null;
  }
}

function originPattern(entry: string): RegExp | null {
  const match = /^https:\/\/([a-z0-9-]+)\*([a-z0-9-]+)((?:\.[a-z0-9-]+){2,})$/.exec(entry);
  if (!match) return null;
  const [, prefix, suffix, rest] = match;
  // both sides of the wildcard must pin the label to one project/team
  if (prefix.length < 3 || suffix.length < 3 || rest.split(".").slice(1).some((label) => !label || label.length > 63)) return null;
  const escape = (text: string) => text.replace(/[.-]/g, (char) => `\\${char}`);
  const room = 63 - prefix.length - suffix.length;
  if (room < 1) return null;
  return new RegExp(`^https:\\/\\/${escape(prefix)}[a-z0-9-]{1,${room}}${escape(suffix)}${escape(rest)}$`);
}

/** Who to count a pairing attempt against. The server binds loopback, so a
 * remote client always arrives through a proxy or tunnel on this machine;
 * that proxy's X-Forwarded-For (Caddy overwrites any the client sent) names
 * the real source. A connection whose peer is not loopback (a future bind to
 * an interface) is the source itself, and its forwarded header is ignored. */
export function requestSource(req: IncomingMessage): string {
  const peer = req.socket?.remoteAddress || "unknown";
  // The LAST hop is the one the adjacent (trusted, same-machine) proxy wrote;
  // earlier hops are whatever the client or an outer proxy put there.
  const hops = viaLocalProxy(req) ? (headerValue(req.headers["x-forwarded-for"]) ?? "").split(",").map((h) => h.trim()).filter(Boolean) : [];
  const forwarded = hops.length ? hops[hops.length - 1] : undefined;
  return sanitizeSource(forwarded || peer);
}

function viaLocalProxy(req: IncomingMessage): boolean {
  const peer = req.socket?.remoteAddress;
  // An IPC listener's only peer is the tunnel gateway on this machine.
  return ipcPeer(req) || peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
}

/** A visitor's address and what named it: "x-real-ip", the header in
 * NATION_CLIENT_IP_HEADER, or "proxy" for requestSource. */
export interface ClientAddress { address: string; from: string }

/** Whom per-network limits count (sign-in links, the sign-in lockout,
 * starter credit). NATION_TRUST_PROXY=1: X-Real-IP, which the server in front
 * writes (a workspace behind the account gateway). NATION_CLIENT_IP_HEADER:
 * the header in which a web front end such as the NATION web app on Vercel
 * names the visitor, read only from a request that came through the proxy on
 * this machine; without it, every browser behind that front end counts as
 * the front end's few addresses. Anyone who reaches the server directly can
 * write that header too, so what it feeds keeps limits of its own that no
 * header changes (one starter credit per mailbox and a daily total). */
export function clientAddressDetail(req: IncomingMessage, env: NodeJS.ProcessEnv = process.env): ClientAddress {
  const realIp = env.NATION_TRUST_PROXY === "1" ? plainAddress(headerValue(req.headers["x-real-ip"])) : null;
  if (realIp) return { address: realIp, from: "x-real-ip" };
  const header = env.NATION_CLIENT_IP_HEADER?.trim().toLowerCase();
  if (header && /^[a-z0-9-]{1,64}$/.test(header) && viaLocalProxy(req)) {
    // The first entry is the visitor; later ones are proxies that passed it on.
    const visitor = plainAddress(headerValue(req.headers[header])?.split(",")[0]);
    if (visitor) return { address: visitor, from: header };
  }
  return { address: requestSource(req), from: "proxy" };
}

export function clientAddress(req: IncomingMessage, env: NodeJS.ProcessEnv = process.env): string {
  return clientAddressDetail(req, env).address;
}

/** An IP address as a header carries it, or null; IPv4-mapped IPv6 as IPv4. */
function plainAddress(value: string | undefined): string | null {
  const text = value?.trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "") ?? "";
  return text && isIP(text) ? text : null;
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
/** Feature gates for client-scoped routes; see ResolveOptions.features. */
export interface ClientFeatures {
  sharedComputers?: boolean;
  /** A member's own workspace (one account, never a shared desk) with NATION cloud computers on. */
  workspaceComputers?: boolean;
  /** A member's own workspace with the guarded built-in browser on. */
  workspaceBrowser?: boolean;
}

export const CLIENT_ALLOW: ReadonlyArray<{ methods: readonly string[]; path: RegExp; feature?: keyof ClientFeatures }> = [
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/avatar\/generate$/ },
  { methods: ["GET"], path: /^\/api\/credits\/status$/ },
  { methods: ["POST"], path: /^\/api\/credits\/(?:invoices|confirm|wallet\/(?:challenge|verify))$/ },
  // The account's own NATION wallet (server/routes/nation-wallet.ts): its passkey holds it.
  { methods: ["GET", "POST"], path: /^\/api\/credits\/wallet\/embedded$/ },
  { methods: ["POST"], path: /^\/api\/credits\/wallet\/embedded\/(?:prepare|pay)$/ },
  // own session
  { methods: ["GET"], path: /^\/api\/auth\/session$/ },
  { methods: ["POST"], path: /^\/api\/auth\/stream-ticket$/ },
  { methods: ["POST"], path: /^\/api\/auth\/logout$/ },
  // Own outbound desktop connector, additionally bound to a private secret.
  // Only honoured while features.sharedComputers is on (see requiredScope):
  // with the feature off these paths are as unlisted as any other, so a
  // client session is refused exactly the way an unknown route refuses it.
  { methods: ["POST"], path: /^\/api\/shared-computers\/(?:connect|[\w-]+\/(?:poll|lease|result|disconnect))$/, feature: "sharedComputers" },
  // liveness, identity, the stream
  { methods: ["GET"], path: /^\/api\/health$/ },

  { methods: ["GET"], path: /^\/api\/brand$/ },
  { methods: ["GET"], path: /^\/api\/events$/ },
  { methods: ["GET"], path: /^\/api\/instances$/ }, // public NATION projection only
  { methods: ["POST"], path: /^\/api\/bots$/ }, // configured defaults only
  // reads: fleet, transcripts, search (no secrets in any of these)
  { methods: ["GET"], path: /^\/api\/bots$/ },
  { methods: ["GET"], path: /^\/api\/team-map$/ },
  // a link into the organisation's Admin: identifiers only, and Admin authorizes its own visitor
  { methods: ["GET"], path: /^\/api\/bots\/[\w-]+\/slack-management$/ },
  { methods: ["GET"], path: /^\/api\/search$/ },
  { methods: ["GET"], path: /^\/api\/threads\/[\w-]+\/messages$/ },
  { methods: ["GET"], path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/image$/ },
  { methods: ["GET"], path: /^\/api\/threads\/[\w-]+\/export$/ },
  { methods: ["POST"], path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/file$/ },
  // chat, one to one
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/messages$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/messages\/[\w-]+\/edit$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/active-branch$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/compact$/ },
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
  // Connected apps: each call acts only on the caller's own account (the
  // handler derives it from the session; there is no account parameter).
  { methods: ["GET"], path: /^\/api\/connectors(?:\/catalog|\/connected)?$/ },
  { methods: ["POST"], path: /^\/api\/connectors\/[\w-]+\/authorize$/ },
  { methods: ["DELETE"], path: /^\/api\/connectors\/[\w-]+(?:\/accounts\/[A-Za-z0-9][A-Za-z0-9_-]{0,127})?$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/connector-cards\/[\w-]+\/authorize$/ },
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
  { methods: ["POST"], path: /^\/api\/routine-runs\/seen-all$/ },
  // webhook list is secret-free; creating or rotating one is not
  { methods: ["GET"], path: /^\/api\/webhooks$/ },
  // configured-or-not booleans; the handler strips the few identifying fields for clients
  { methods: ["GET"], path: /^\/api\/config$/ },
  // first-run progress, language and display name; only in a workspace of one's own
  { methods: ["PATCH"], path: /^\/api\/workspace\/preferences$/ },
  // A member's own workspace: its cloud computer and browser. Each handler
  // resolves the signed-in account's own computer and browser session, never
  // the bot's own or another account's.
  { methods: ["GET"], path: /^\/api\/bots\/[\w-]+\/computer$/, feature: "workspaceComputers" },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/computer\/(?:provision|sleep|screenshot)$/, feature: "workspaceComputers" },
  { methods: ["GET"], path: /^\/api\/bots\/[\w-]+\/browser\/live$/, feature: "workspaceBrowser" },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/browser\/action$/, feature: "workspaceBrowser" },
];

export function requiredScope(method: string, path: string, features: ClientFeatures = {}): Scope {
  const upper = method.toUpperCase();
  for (const rule of CLIENT_ALLOW) {
    if (rule.feature && features[rule.feature] !== true) continue;
    if (rule.path.test(path) && rule.methods.includes(upper)) return "client";
  }
  return "admin";
}

/** Fields a client session may change on a bot: how it looks in the list,
 * never what it may do. Returns the first offending field, or null.
 * Pass `extraAllowed` to permit additional fields for the calling context
 * (e.g. hosted-model workspaces allow `modelSelection`). */
const CLIENT_BOT_PATCH_FIELDS = new Set(["unread", "pinned", "pinnedMessageId", "color", "mascotExpression", "mascotBody"]);
export function clientBotPatchViolation(body: unknown, extraAllowed?: ReadonlySet<string>): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "body";
  for (const key of Object.keys(body)) {
    if (!CLIENT_BOT_PATCH_FIELDS.has(key) && !extraAllowed?.has(key)) return key;
  }
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
  /** Feature gates that decide whether a client-scoped route exists at all.
   * Absent means off, so an ungated build refuses like one without it. */
  features?: ClientFeatures;
  /** Whether an unauthenticated loopback request is this server's owner. A
   * member workspace started by the public NATION server says no: reaching
   * its port from this machine proves nothing (workspace-host.ts). */
  loopbackOwner?: boolean;
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
    path !== "/api/auth/pair" &&
    // The same exchange under the shape the companion apps send.
    path !== "/api/pair";
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
    const needed = requiredScope(method, path, options.features ?? {});
    if (!session.scopes.includes(needed)) {
      return deny(403, `forbidden: this session lacks the ${needed} scope`);
    }
    // Only a request that passed both checks counts as use of the session,
    // and only a request the client made itself: redeeming a stream ticket
    // is the tail of an API call that already counted, and a stream left
    // open unattended must not keep a session alive on its own.
    if (via !== "ticket") options.sessions.renew(session.id);
    return { auth: { kind: "session", session, via, scopes: session.scopes }, status: 401, error: "" };
  }

  // A removed email member must not become the loopback owner merely because
  // their now-invalid cookie or bearer was presented to a local address.
  if (via) {
    return deny(401, "unauthorized: this session has expired or was revoked; pair this device again");
  }

  if (options.loopbackOwner === false) {
    // Agent integrations on this machine reach /api/internal/* with their own
    // per-turn capability, which that handler checks. They pass here with no
    // scope at all, so nothing else is open to them.
    if (path.startsWith("/api/internal/") && !isProxied(req) && isLoopbackHost(headerValue(req.headers.host))) {
      return { auth: { kind: "loopback", scopes: [] }, status: 401, error: "" };
    }
    return deny(401, "unauthorized: sign in to use this workspace");
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

  if (proxied) {
    return deny(403, "forbidden: this request came through a proxy (pair this device to use the server remotely)");
  }
  if (!isLoopbackHost(headerValue(req.headers.host))) {
    return deny(403, "forbidden: loopback host required (pair this device to use the server remotely)");
  }
  return deny(403, "forbidden: cross-origin request");
}
