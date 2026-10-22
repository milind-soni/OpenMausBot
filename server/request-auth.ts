// Loopback requests (Host and Origin both loopback) or paired sessions (bearer, cookie, stream ticket); a session swaps the loopback rule for same-origin (CSRF) and a scope check.
// Browsers never get loopback trust: a page a bot opens is a browser on this machine too.
import type { IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import type { Scope, SessionRecord, SessionRegistry } from "./sessions.ts";
import { denyReason as companionDenial, isCompanionNotice } from "../companion/src/routes.ts";

/** `owner`: the machine's owner. `service`: a shared server where every bot's shell is a loopback caller too,
 * so loopback without a session may reach only SERVICE_ALLOW. */
export type LoopbackTrust = "owner" | "service";

export type RequestAuth =
  | { kind: "loopback"; scopes: readonly Scope[]; trust?: "service" }
  | { kind: "session"; session: SessionRecord; via: "bearer" | "cookie" | "ticket"; scopes: readonly Scope[] };

export interface RequestAuthResult {
  auth: RequestAuth | null;
  status: 401 | 403;
  error: string;
}

const LOOPBACK_SCOPES: readonly Scope[] = ["admin", "client"];
const SERVICE_SCOPES: readonly Scope[] = ["client"];

/** What a `service`-trust loopback caller may reach: health and identity, the cloud Slack worker's routes (it
 * shares the workspace's network namespace), and the turn-scoped capability routes, whose bearer the handler checks.
 *
 * Open risk: a bot's shell is a loopback caller too, so it can do everything the Slack worker does: post into any
 * bot's thread through the guarded route, including an existing Full-access thread, open new Full-access threads
 * while the operator's shared Full access is on, stop a request and decline a card. Planned fix: a relay token only
 * the Slack worker holds, so these routes stop answering session-less loopback. */
export const SERVICE_ALLOW: ReadonlyArray<{ methods: readonly string[]; path: RegExp }> = [
  { methods: ["GET"], path: /^\/api\/health$/ },
  { methods: ["GET"], path: /^\/api\/auth\/session$/ },
  { methods: ["GET"], path: /^\/api\/edition$/ },
  { methods: ["GET"], path: /^\/api\/brand$/ },
  { methods: ["GET"], path: /^\/api\/bots$/ },
  { methods: ["GET"], path: /^\/api\/threads\/[\w-]+\/messages$/ },
  { methods: ["GET"], path: /^\/api\/attachments\/[\w.-]+$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/tasks$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/messages\/guarded$/ },
  { methods: ["GET"], path: /^\/api\/bots\/[\w-]+\/requests\/[\w-]+$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/requests\/[\w-]+\/interrupt$/ },
  { methods: ["DELETE"], path: /^\/api\/bots\/[\w-]+\/queue\/[\w-]+$/ },
  { methods: ["POST"], path: /^\/api\/threads\/[\w-]+\/respond$/ }, // decline only: see the handler
  { methods: ["GET", "POST", "PUT", "PATCH", "DELETE"], path: /^\/api\/internal\// }, // capability bearer checked in the handler
  { methods: ["POST"], path: /^\/api\/testing\/internal-capability$/ }, // exists only with its private key
];

export function serviceAllowed(method: string, path: string): boolean {
  const upper = method.toUpperCase();
  return SERVICE_ALLOW.some((rule) => rule.methods.includes(upper) && rule.path.test(path));
}

/** Owner-trust loopback (the desktop app) or an admin-scoped session (a paired owner device, the owner's Cloud session);
 * never service-trust loopback (a shared server's bot shells) or a guest. */
export function ownerOrAdmin(auth: RequestAuth): boolean {
  return auth.kind === "loopback" ? auth.trust !== "service" : auth.scopes.includes("admin");
}

/** Packaged desktop: `owner`. Else OMB_LOOPBACK_TRUST=owner|service; unset, a hosted workspace (any OMB_ADMIN_*)
 * gets `service` and a headless server `owner`. Any other value fails closed. `localBrowsers`: see localBrowserTrust. */
export function resolveLoopbackTrust(input: {
  env?: NodeJS.ProcessEnv;
  desktopManaged: boolean;
  hostedWorkspace: boolean;
  /** A Cloud home's network traffic arrives through its edge proxy, so bare loopback is a bot's shell: always `service`. */
  cloudHome?: boolean;
  /** This server runs from TypeScript source rather than a build. */
  fromSource?: boolean;
}): { trust: LoopbackTrust; reason: string; warning?: string; localBrowsers: boolean } {
  const resolved = loopbackTrust(input);
  const browsers = localBrowserTrust(input.env ?? process.env, input.fromSource === true && !input.desktopManaged, resolved.trust);
  const warning = [resolved.warning, browsers.warning].filter(Boolean).join("; ");
  return { trust: resolved.trust, reason: resolved.reason, ...(warning ? { warning } : {}), localBrowsers: browsers.trusted };
}

function loopbackTrust(input: Parameters<typeof resolveLoopbackTrust>[0]): { trust: LoopbackTrust; reason: string; warning?: string } {
  const raw = (input.env ?? process.env).OMB_LOOPBACK_TRUST;
  const requested = raw?.trim().toLowerCase();
  if (input.cloudHome) {
    return { trust: "service", reason: "MausBot Cloud home", ...(raw !== undefined && requested !== "service" ? { warning: "OMB_LOOPBACK_TRUST is ignored on a MausBot Cloud home: a local request is always a service" } : {}) };
  }
  if (input.desktopManaged) {
    return { trust: "owner", reason: "desktop app", ...(raw !== undefined ? { warning: "OMB_LOOPBACK_TRUST is ignored in the desktop app" } : {}) };
  }
  if (requested === "owner" || requested === "service") {
    return {
      trust: requested,
      reason: "OMB_LOOPBACK_TRUST",
      ...(requested === "owner" && input.hostedWorkspace
        ? { warning: "OMB_LOOPBACK_TRUST=owner on a shared workspace: every bot's shell can change settings and approve cards as the owner" }
        : {}),
    };
  }
  if (raw !== undefined && requested !== "") {
    return { trust: "service", reason: "OMB_LOOPBACK_TRUST", warning: `OMB_LOOPBACK_TRUST="${raw.replace(/[^\w.-]/g, "").slice(0, 40)}" is not owner or service; using service` };
  }
  if (input.hostedWorkspace) return { trust: "service", reason: "hosted workspace" };
  return { trust: "owner", reason: "self-hosted default" };
}

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

/** Browsers send Sec-Fetch-Site and Sec-Fetch-Dest on every request to a loopback address and Origin on every WebSocket
 * handshake (Chrome 155 sends no Sec-Fetch-* there); a page can remove none of them. Node's fetch (undici) sends
 * Sec-Fetch-Mode alone, so it does not count; curl, the companion and the desktop app's main process send none. */
export function fromBrowser(req: IncomingMessage): boolean {
  const headers = req.headers;
  if (headers["sec-fetch-site"] !== undefined || headers["sec-fetch-dest"] !== undefined) return true;
  return headerValue(headers.upgrade)?.toLowerCase() === "websocket" && headers.origin !== undefined;
}

const LOCAL_BROWSER_TRUST = "OMB_DEV_TRUST_LOCAL_BROWSER";

/** Development only: a server run from a source checkout (`pnpm dev:server`, test fixtures) lets this machine's browsers in
 * as before, because Vite's dev proxy forwards them; a packaged, bundled, hosted or service-trust server ignores it. */
function localBrowserTrust(env: NodeJS.ProcessEnv, fromSource: boolean, trust: LoopbackTrust): { trusted: boolean; warning?: string } {
  if (env[LOCAL_BROWSER_TRUST] !== "1") return { trusted: false };
  if (!fromSource || trust !== "owner") {
    return { trusted: false, warning: `${LOCAL_BROWSER_TRUST} is ignored: it applies only to a development server run from source with owner trust` };
  }
  return { trusted: true, warning: `${LOCAL_BROWSER_TRUST}=1: browsers on this machine act as the owner (development only)` };
}

export const BROWSER_SIGN_IN = "unauthorized: this browser is not signed in. Open the sign-in link that openmausbot serve or openmausbot pair prints on this computer, or pair it with a code from Settings → Remote access";

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

export function requestOrigin(req: IncomingMessage): string | null {
  const host = headerValue(req.headers.host)?.trim();
  if (!host) return null;
  const forwarded = headerValue(req.headers["x-forwarded-proto"])?.split(",")[0]?.trim().toLowerCase();
  const proto = forwarded === "https" || forwarded === "http" ? forwarded : "http";
  return `${proto}://${host.toLowerCase()}`;
}

/** A proxy that hands the server a loopback Host must not turn a remote client into the owner. */
export function isProxied(req: IncomingMessage): boolean {
  const h = req.headers;
  return ipcPeer(req) || Boolean(h["x-forwarded-for"] || h["x-forwarded-proto"] || h["x-forwarded-host"] || h["forwarded"]);
}

/** An IPC listener's only peer is a forwarding gateway, so its requests are remote: never loopback trust. */
export function ipcPeer(req: IncomingMessage): boolean {
  const socket = req.socket;
  return Boolean(socket) && socket.remoteAddress === undefined && socket.remoteFamily === undefined;
}

export function isSameOrigin(req: IncomingMessage): boolean {
  const origin = headerValue(req.headers.origin);
  if (!origin) return true;
  const own = requestOrigin(req);
  return own !== null && origin.trim().toLowerCase() === own;
}

/** Unlike isSameOrigin, a request with neither Origin nor Sec-Fetch-Site fails. */
export function provesSameOrigin(req: IncomingMessage): boolean {
  if (headerValue(req.headers.origin)) return isSameOrigin(req);
  return headerValue(req.headers["sec-fetch-site"])?.trim().toLowerCase() === "same-origin";
}

/** Remote clients arrive through a local proxy whose X-Forwarded-For names the source (Caddy overwrites the client's). */
export function requestSource(req: IncomingMessage): string {
  const peer = req.socket?.remoteAddress || "unknown";
  const viaLocalProxy = ipcPeer(req) || peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
  // Only the LAST hop was written by the trusted same-machine proxy.
  const hops = viaLocalProxy ? (headerValue(req.headers["x-forwarded-for"]) ?? "").split(",").map((h) => h.trim()).filter(Boolean) : [];
  const forwarded = hops.length ? hops[hops.length - 1] : undefined;
  return sanitizeSource(forwarded || peer);
}

/** Bounded and address-shaped, so a hostile header cannot put control characters in logs or grow the lockout map. */
export function sanitizeSource(value: string): string {
  const clean = value.replace(/[^\w.:%[\]-]/g, "");
  return (clean || "unknown").slice(0, 64);
}

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

/** Cookies are scoped by host, not port; the environment id stops a reinstalled server reading its predecessor's cookie. */
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

/** What a `client` session may do. Default deny: a new route is admin-only until listed here. */
export const CLIENT_ALLOW: ReadonlyArray<{ methods: readonly string[]; path: RegExp; feature?: "sharedComputers" }> = [
  { methods: ["GET"], path: /^\/api\/auth\/session$/ },
  // the update check only reads a version
  { methods: ["GET"], path: /^\/api\/updates\/check$/ },
  { methods: ["POST"], path: /^\/api\/auth\/stream-ticket$/ },
  { methods: ["POST"], path: /^\/api\/auth\/logout$/ },
  // A Team Cloud member's own phone: the code carries their address and role, never more (routes/team-phone.ts).
  { methods: ["POST"], path: /^\/api\/team\/phone-pairing$/ },
  // Own desktop connector, bound to a private secret; listed only while features.sharedComputers is on.
  { methods: ["POST"], path: /^\/api\/shared-computers\/(?:connect|[\w-]+\/(?:poll|lease|result|disconnect))$/, feature: "sharedComputers" },
  { methods: ["GET"], path: /^\/api\/shared-computers$/, feature: "sharedComputers" },
  // The same desktop's device link: a WebSocket bound to that secret too.
  { methods: ["GET"], path: /^\/api\/shared-computers\/[\w-]+\/link$/, feature: "sharedComputers" },
  { methods: ["GET"], path: /^\/api\/health$/ },
  { methods: ["GET"], path: /^\/api\/edition$/ },
  { methods: ["GET"], path: /^\/api\/brand$/ },
  { methods: ["GET"], path: /^\/api\/events$/ },
  // reads that carry no secrets
  { methods: ["GET"], path: /^\/api\/bots$/ },
  { methods: ["GET"], path: /^\/api\/team-map$/ },
  // a link into the organisation's Admin: identifiers only, and Admin authorizes its own visitor
  { methods: ["GET"], path: /^\/api\/bots\/[\w-]+\/slack-management$/ },
  { methods: ["GET"], path: /^\/api\/search$/ },
  { methods: ["GET"], path: /^\/api\/threads\/[\w-]+\/messages$/ },
  { methods: ["GET"], path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/image$/ },
  // an app row's document is transcript data, read under the transcript's rules
  { methods: ["GET"], path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/app$/ },
  { methods: ["GET"], path: /^\/api\/threads\/[\w-]+\/export$/ },
  { methods: ["GET"], path: /^\/api\/threads\/[\w-]+\/evidence(?:\.tar|\/[A-Za-z0-9-]{8,64}\/step-\d{6,12}\.jpg)?$/ },
  { methods: ["POST"], path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/file$/ },
  { methods: ["GET"], path: /^\/api\/threads\/[\w-]+\/job$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/messages$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/messages\/[\w-]+\/edit$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/active-branch$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/compact$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/interrupt$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/read$/ },
  { methods: ["DELETE"], path: /^\/api\/bots\/[\w-]+\/queue\/[\w-]+$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/queue\/[\w-]+\/steer$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/tasks$/ },
  { methods: ["POST", "PATCH", "DELETE"], path: /^\/api\/bots\/[\w-]+\/tasks\/[\w-]+$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/tasks\/[\w-]+\/title$/ },
  { methods: ["PATCH"], path: /^\/api\/bots\/[\w-]+\/profile$/ },
  { methods: ["PATCH"], path: /^\/api\/bots\/[\w-]+$/ }, // display fields only: see clientBotPatchViolation
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/respond$/ },
  { methods: ["POST"], path: /^\/api\/threads\/[\w-]+\/respond$/ },
  { methods: ["POST"], path: /^\/api\/threads\/[\w-]+\/undo$/ }, // whoever may answer the card: see the handler
  { methods: ["PATCH"], path: /^\/api\/bots\/[\w-]+\/cards\/[\w-]+$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/secret-cards\/[\w-]+\/(?:resume|dismiss)$/ },
  // Save a login: the password goes to the encrypted store, and no client route reads one back.
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/sign-in-cards\/[\w-]+\/(?:done|cancel|save-login)$/ },
  // Where a login saved from the card would fill: the host of the bot's open page, which its live view shows anyway.
  { methods: ["GET"], path: /^\/api\/bots\/[\w-]+\/sign-in-cards\/[\w-]+\/save-login$/ },
  // A member reaches only the bots shown to them.
  { methods: ["GET"], path: /^\/api\/bots\/[\w-]+\/browser\/live$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/browser\/action$/ },
  { methods: ["GET"], path: /^\/api\/bots\/[\w-]+\/browser\/(?:stream|download\/[\w-]+)$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/browser\/upload$/ },
  { methods: ["GET"], path: /^\/api\/bots\/[\w-]+\/connector-cards\/[\w-]+\/status$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/connector-cards\/[\w-]+\/(?:resume|dismiss)$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/always-allow$/ }, // must match a pending card
  // an app reaches only its own MCP server, under the bot's rules; its context is bounded text
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/apps\/[\w-]+\/(?:rpc|context)$/ },
  { methods: ["POST"], path: /^\/api\/groups$/ },
  { methods: ["POST"], path: /^\/api\/groups\/[\w-]+\/messages$/ },
  { methods: ["POST"], path: /^\/api\/groups\/[\w-]+\/interrupt$/ },
  { methods: ["POST"], path: /^\/api\/groups\/[\w-]+\/members\/[\w-]+\/compact$/ },
  { methods: ["POST"], path: /^\/api\/groups\/[\w-]+\/read$/ },
  { methods: ["DELETE"], path: /^\/api\/groups\/[\w-]+\/queue\/[\w-]+$/ },
  { methods: ["POST"], path: /^\/api\/groups\/[\w-]+\/queue\/[\w-]+\/steer$/ },
  { methods: ["POST"], path: /^\/api\/groups\/[\w-]+\/tasks$/ },
  { methods: ["POST", "PATCH", "DELETE"], path: /^\/api\/groups\/[\w-]+\/tasks\/[\w-]+$/ },
  { methods: ["PATCH"], path: /^\/api\/groups\/[\w-]+$/ }, // display fields only: see clientGroupPatchViolation
  { methods: ["POST"], path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/reactions$/ },
  { methods: ["POST"], path: /^\/api\/attachments$/ },
  { methods: ["GET"], path: /^\/api\/attachments\/[\w.-]+$/ },
  { methods: ["POST"], path: /^\/api\/files$/ },
  // voice: labels and audio, never the key
  { methods: ["GET"], path: /^\/api\/tts\/voices$/ },
  { methods: ["POST"], path: /^\/api\/tts\/prepare$/ },
  { methods: ["POST"], path: /^\/api\/tts\/speak$/ },
  // routines: the input carries no cwd or permission field
  { methods: ["GET"], path: /^\/api\/routines$/ },
  { methods: ["POST"], path: /^\/api\/routines$/ },
  { methods: ["PATCH", "DELETE"], path: /^\/api\/routines\/[\w-]+$/ },
  { methods: ["POST"], path: /^\/api\/routines\/[\w-]+\/run$/ },
  { methods: ["POST"], path: /^\/api\/routine-runs\/[\w-]+\/(?:cancel|seen)$/ },
  { methods: ["POST"], path: /^\/api\/routine-runs\/seen-all$/ },
  // webhook list is secret-free; creating or rotating one is not
  { methods: ["GET"], path: /^\/api\/webhooks$/ },
  // app-event automations: the list carries no credential; creating or changing one is the owner's
  { methods: ["GET"], path: /^\/api\/app-triggers$/ },
  // counts and lines from the threads this viewer can see; engine and app fixes only for an admin
  { methods: ["GET"], path: /^\/api\/today$/ },
  // configured-or-not booleans; the handler strips the few identifying fields for clients
  { methods: ["GET"], path: /^\/api\/config$/ },
  // a person's own "About you" on a Team Cloud
  { methods: ["GET", "PUT"], path: /^\/api\/me$/ },
  // a Team Cloud's member moving a bot of their own in: it answers with a sign-in for that one bot
  { methods: ["POST"], path: /^\/api\/team-move-in$/ },
];

export function requiredScope(method: string, path: string, features: { sharedComputers?: boolean } = {}): Scope {
  const upper = method.toUpperCase();
  for (const rule of CLIENT_ALLOW) {
    if (rule.feature && features[rule.feature] !== true) continue;
    if (rule.path.test(path) && rule.methods.includes(upper)) return "client";
  }
  return "admin";
}

/** A client may change how a bot looks, never what it may do. */
const CLIENT_BOT_PATCH_FIELDS = new Set([
  "unread", "pinned", "pinnedMessageId", "color", "mascotExpression", "mascotBody",
  "avatarUrl", "avatarCrop", "avatarZoom", "avatarFocusX", "avatarFocusY",
]);
export function clientBotPatchViolation(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "body";
  for (const key of Object.keys(body)) if (!CLIENT_BOT_PATCH_FIELDS.has(key)) return key;
  return null;
}

/** Same for a room: name and reading state, never its folder or who answers. */
const CLIENT_GROUP_PATCH_FIELDS = new Set(["name", "bulletin", "unread", "pinnedMessageId", "section", "turnTimeoutMinutes"]);
export function clientGroupPatchViolation(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "body";
  for (const key of Object.keys(body)) if (!CLIENT_GROUP_PATCH_FIELDS.has(key)) return key;
  return null;
}

export interface ResolveOptions {
  sessions: SessionRegistry;
  cookieName: string;
  streamPath: string;
  url: URL;
  /** Desktop capability over Electron's private child port: with it, every public loopback mutation must come through the desktop's web session. */
  loopbackMutationToken?: string;
  companionMutationToken?: string;
  features?: { sharedComputers?: boolean };
  /** Absent is `owner`; ignored while loopbackMutationToken is in force. */
  loopbackTrust?: LoopbackTrust;
  /** Under `service`: a per-launch secret from `openmausbot serve` over stdin (never env, which other children read); it opens only pairing codes. */
  cliOwnerToken?: string;
  /** resolveLoopbackTrust's `localBrowsers`: a development server lets this machine's browsers use loopback trust. */
  trustLocalBrowser?: boolean;
  /** Why a session made for one task may not make this request (a Team Cloud's sign-in that moves one bot in), else null. */
  restricted?(session: SessionRecord, method: string, path: string, url: URL): string | null;
}

const CLI_OWNER_HEADER = "x-openmausbot-cli-owner";
const CLI_OWNER_ROUTE = /^\/api\/auth\/pairing$/;

const DESKTOP_OWNER_HEADER = "x-openmausbot-desktop-owner";

function mutatingPublicRoute(method: string, path: string): boolean {
  const upper = method.toUpperCase();
  // A legacy GET that syncs upstream state and can resume a paused turn: classify by effect, not verb.
  if (
    upper === "GET" &&
    /^\/api\/bots\/[\w-]+\/connector-cards\/[\w-]+\/status$/.test(path)
  ) return true;
  // Hands out a desktop's VNC password and control.
  if (path.startsWith("/api/desktop-viewer/")) return true;
  // Drives a bot's browser: a WebSocket upgrade is a GET, but what it carries is input.
  if (/^\/api\/bots\/[\w-]+\/browser\/stream$/.test(path)) return true;
  if (["GET", "HEAD", "OPTIONS"].includes(upper)) return false;
  // Internal routes carry their own per-boot authorization; pairing-code exchange is public (the one-time code is its authorization).
  return !path.startsWith("/api/internal/") &&
    path !== "/api/testing/internal-capability" &&
    path !== "/api/auth/pair" &&
    path !== "/api/pair";
}

function secureTokenMatch(actual: string | undefined, expected: string): boolean {
  if (!actual || !expected) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function resolveRequestAuth(req: IncomingMessage, options: ResolveOptions): RequestAuthResult {
  const method = req.method ?? "GET";
  const path = options.url.pathname;
  const deny = (status: 401 | 403, error: string): RequestAuthResult => ({ auth: null, status, error });

  // A presented session credential wins over the loopback rule.
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
    // A browser sign-in's session is its cookie, never a bearer token.
    if (via === "bearer" && session.cookieOnly) return deny(401, "unauthorized: this session belongs to a browser; sign in with a pairing code");
    if (via === "cookie" && session.cookieOnly && !["GET", "HEAD", "OPTIONS"].includes(method) && !provesSameOrigin(req)) {
      return deny(403, "forbidden: this browser's session makes changes only from its own page");
    }
    const narrowed = options.restricted?.(session, method, path, options.url) ?? null;
    if (narrowed) return deny(403, narrowed);
    const needed = requiredScope(method, path, options.features ?? {});
    if (!session.scopes.includes(needed)) {
      return deny(403, `forbidden: this session lacks the ${needed} scope`);
    }
    // Redeeming a stream ticket does not renew: an unattended open stream must not keep a session alive.
    if (via !== "ticket") options.sessions.renew(session.id);
    return { auth: { kind: "session", session, via, scopes: session.scopes }, status: 401, error: "" };
  }

  // A removed member's invalid credential must not fall back to loopback owner.
  if (via) {
    return deny(401, "unauthorized: this session has expired or was revoked; pair this device again");
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
        (companionDenial({ path, method, authenticated: true }) && !isCompanionNotice(method, path))
      ) return deny(403, "forbidden: invalid companion request");
      return { auth: { kind: "loopback", scopes: LOOPBACK_SCOPES }, status: 401, error: "" };
    }
    const desktopOwner = options.loopbackMutationToken !== undefined &&
      secureTokenMatch(headerValue(req.headers[DESKTOP_OWNER_HEADER]), options.loopbackMutationToken);
    if (fromBrowser(req) && !desktopOwner && !options.trustLocalBrowser) return deny(401, BROWSER_SIGN_IN);
    if (options.loopbackMutationToken !== undefined && mutatingPublicRoute(method, path) && !desktopOwner) {
      return deny(403, "forbidden: this change must come from the desktop app or a paired device");
    }
    if (options.loopbackMutationToken === undefined && options.loopbackTrust === "service") {
      if (
        options.cliOwnerToken && CLI_OWNER_ROUTE.test(path) && ["GET", "POST"].includes(method.toUpperCase()) &&
        secureTokenMatch(headerValue(req.headers[CLI_OWNER_HEADER]), options.cliOwnerToken)
      ) {
        return { auth: { kind: "loopback", scopes: LOOPBACK_SCOPES }, status: 401, error: "" };
      }
      // On a shared server "local" includes every bot's shell: default deny outside SERVICE_ALLOW.
      if (!serviceAllowed(method, path)) {
        return deny(403, "forbidden: on this shared server a local request without a session may only use the service routes; sign in to change settings, people or access");
      }
      return { auth: { kind: "loopback", scopes: SERVICE_SCOPES, trust: "service" }, status: 401, error: "" };
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
