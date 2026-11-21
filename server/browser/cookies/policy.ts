// What may move from another browser into a bot's browser, and in what shape. Security: a cookie value never appears in
// a message, a log line or an error made here; only counts and reason codes leave this module.
//
// The cookie shape and the host-only and expiry rules follow anomalyco/opencode@5ca87b9
// packages/gui-plugins/src/browser/profile/cookie.ts (ImportedCookie, cookieDetails, cookieURL), MIT License,
// Copyright (c) 2025 opencode (full text in third_party/opencode/LICENSE). The Google exclusion follows
// stablyai/orca@ffadf731 src/main/browser/cookies/policy/cookie-import-exclusions.ts, MIT License, Copyright (c) 2026
// Lovecast Inc. (full text in third_party/orca/LICENSE). Modified: one site per import, and skip reasons counted.
import { getDomain } from "tldts";

/** A cookie as another browser stores it, before it is written anywhere. */
export interface SourceCookie {
  /** `.github.com` for a domain cookie, `github.com` for a host-only one. */
  host: string;
  name: string;
  value: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** Unix seconds; undefined for a session cookie. */
  expires: number | undefined;
  sameSite: "unspecified" | "no_restriction" | "lax" | "strict";
  /** Set when the cookie lives in a partition (CHIPS), which no destination here can write. */
  partitioned?: boolean;
}

/** The shape every destination takes: Electron's `cookies.set` details, which CDP's `Storage.setCookies` maps from. */
export interface WritableCookie {
  url: string;
  name: string;
  value: string;
  /** Absent for a host-only cookie. */
  domain?: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: SourceCookie["sameSite"];
  /** Absent for a session cookie, which lasts until the bot's browser quits. */
  expirationDate?: number;
}

export type SkipReason = "expired" | "partitioned" | "insecure-none" | "host-prefix" | "secure-prefix" | "empty" | "google";

/**
 * Google ties these cookies to the browser that made them; a copy is flagged, and the account is signed out within the
 * hour. Google's own sign-in is done in the bot's browser itself or in My Chrome.
 */
const GOOGLE_SOURCE_BOUND = new Set(["SIDCC", "__Secure-1PSIDCC", "__Secure-3PSIDCC", "__Secure-STRP", "AEC"]);
const NOT_TRANSPLANTABLE = ["google.com"];

const bare = (host: string) => host.replace(/^\./, "").toLowerCase();

/** Whether a cookie of this host and name is Google's, which is never imported. */
export function googleCookie(host: string, name: string): boolean {
  const domain = bare(host);
  if (NOT_TRANSPLANTABLE.some((root) => domain === root || domain.endsWith(`.${root}`))) return true;
  return GOOGLE_SOURCE_BOUND.has(name) && domain.endsWith(".google.com");
}

/**
 * The site a person asked for, as its registrable domain ("app.github.com" → "github.com"), or null for something that
 * is not one: an address, a public suffix, a hosting platform's shared suffix such as github.io, or an IP literal.
 */
export function importSite(input: string): string | null {
  let host = input.trim().toLowerCase();
  if (/^[a-z][a-z0-9+.-]*:\/\//u.test(host)) {
    try { host = new URL(host).hostname; } catch { return null; }
  }
  host = host.replace(/\.$/u, "");
  if (!/^[a-z0-9.-]{1,253}$/u.test(host) || !host.includes(".")) return null;
  const domain = getDomain(host, { allowPrivateDomains: true });
  return domain && domain === getDomain(domain, { allowPrivateDomains: true }) ? domain : null;
}

/** Whether a cookie of `host` belongs to `site` (a registrable domain). */
export function inSite(host: string, site: string): boolean {
  const domain = bare(host);
  return domain === site || domain.endsWith(`.${site}`);
}

/** The address a cookie is sent to, which Electron's `cookies.set` and CDP's `Storage.setCookies` derive it from. */
function cookieUrl(cookie: SourceCookie): string {
  const host = bare(cookie.host);
  const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${cookie.secure ? "https" : "http"}://${bracketed}${cookie.path.startsWith("/") ? cookie.path : "/"}`;
}

/** One source cookie as a destination writes it, or why it is left behind. */
export function writable(cookie: SourceCookie, now = Date.now() / 1000): WritableCookie | { skip: SkipReason } {
  if (googleCookie(cookie.host, cookie.name)) return { skip: "google" };
  if (!bare(cookie.host) || (!cookie.name && !cookie.value)) return { skip: "empty" };
  if (cookie.partitioned) return { skip: "partitioned" };
  if (cookie.expires !== undefined && cookie.expires <= now) return { skip: "expired" };
  // Chromium refuses these itself; counting them here says why the number is lower.
  if (cookie.sameSite === "no_restriction" && !cookie.secure) return { skip: "insecure-none" };
  if (cookie.name.startsWith("__Secure-") && !cookie.secure) return { skip: "secure-prefix" };
  if (cookie.name.startsWith("__Host-") && (!cookie.secure || cookie.path !== "/" || cookie.host.startsWith("."))) return { skip: "host-prefix" };
  const domain = cookie.host.startsWith(".") ? cookie.host : undefined;
  return {
    url: cookieUrl(cookie),
    name: cookie.name,
    value: cookie.value,
    ...(domain ? { domain } : {}),
    path: cookie.path.startsWith("/") ? cookie.path : "/",
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    ...(cookie.expires !== undefined ? { expirationDate: cookie.expires } : {}),
  };
}
