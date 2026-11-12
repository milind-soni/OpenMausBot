// Who may talk to the harness API. The server drives agents that edit files
// and run commands, so a request is only trusted when it demonstrably comes
// from the app's own page (or a local non-browser client like the agents
// proxy):
//  - Host must be loopback — a DNS-rebinding page reaches 127.0.0.1 under
//    its own hostname, and that name fails here. A server deliberately bound
//    to a LAN interface (GBS_HOST) opts out of this one check.
//  - A browser request must be same-origin: Origin (when sent) must match
//    Host, and Sec-Fetch-Site must not say cross-site/same-site. Non-browser
//    clients send neither header and pass.
//  - A request body must be JSON, so a plain HTML form or a CORS-"simple"
//    text/plain fetch can't smuggle a command in.
// Pure functions over headers — shared by the server and the Vite dev proxy.
import type { IncomingHttpHeaders } from "node:http";

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

function hostnameOf(hostHeader: string): string | null {
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return null;
  }
}

export interface GuardOptions {
  /** true when the operator bound the server to a non-loopback interface */
  allowAnyHost?: boolean;
}

/** Returns a rejection reason, or null when the request may proceed. */
export function rejectUntrustedRequest(headers: IncomingHttpHeaders, options: GuardOptions = {}): string | null {
  const host = headers.host;
  if (!host) return "missing Host header";
  const hostname = hostnameOf(host);
  if (!hostname) return "invalid Host header";
  if (!options.allowAnyHost && !isLoopbackHostname(hostname)) return `untrusted Host: ${host}`;

  const fetchSite = headers["sec-fetch-site"];
  if (fetchSite === "cross-site" || fetchSite === "same-site") return "cross-origin request refused";

  const origin = headers.origin;
  if (origin !== undefined) {
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      /* "null" and other opaque origins */
    }
    if (originHost !== host.toLowerCase()) return "cross-origin request refused";
  }
  return null;
}

/** A body-carrying request must declare JSON. */
export function isJsonContentType(headers: IncomingHttpHeaders): boolean {
  const type = headers["content-type"];
  return typeof type === "string" && /^application\/json\s*(;|$)/i.test(type);
}

/** Only capability-bearing, read-only preview assets bypass the origin check.
 * The server validates the unguessable capability against its project before
 * reading anything. Never use this exception for another /api route.
 */
export function isPreviewAssetRead(method: string | undefined, rawUrl: string | undefined): boolean {
  if (method !== "GET" || !rawUrl?.startsWith("/") || rawUrl.startsWith("//")) return false;
  try {
    // Match the WHATWG-normalized pathname used by the harness router.
    // Raw prefixes can disappear through literal or encoded dot segments.
    const path = new URL(rawUrl, "http://localhost").pathname;
    return /^\/api\/preview\/asset\/[a-f0-9]{64}\/[^/]+\/.+$/.test(path);
  } catch {
    return false;
  }
}
