// Who this server publishes pages as: the MausBot account it is signed in to. One mechanism on every surface: ask the
// Admin for a short-lived upload token, then send the page to the pages Worker with it. Only the credential differs:
//   a Cloud home signs its request with the bootstrap secret it already shares with the Admin;
//   a desktop's main process fetches its sign-in's own pages token and hands it over on the private parent port.
// Neither is ever written to config, sent to a client, or given to an engine. No Cloudflare credential is held here.
import { createHash, createHmac, randomBytes } from "node:crypto";

export const PAGES_TOKEN_PATH = "/api/cloud/pages/token";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export type PagesAccess =
  | { kind: "desktop"; url: string; token: string }
  | { kind: "home"; url: string; machineId: string; secret: string };

/** Must match openmaus-cloud server/cloud-pages.ts `pagesHomeSignature`. */
export function pagesHomeSignature(secret: string, machineId: string, timestamp: string, nonce: string, body: string): string {
  const bodyHash = createHash("sha256").update(body).digest("base64url");
  return createHmac("sha256", secret).update(`omb-pages-v1\n${machineId}\n${timestamp}\n${nonce}\n${bodyHash}`).digest("base64url");
}

/** The headers that prove a request to the Admin's token route comes from this account. */
export function pagesAuthHeaders(access: PagesAccess, body: string, now = Date.now()): Record<string, string> {
  if (access.kind === "desktop") return { authorization: `Bearer ${access.token}` };
  const timestamp = String(Math.floor(now / 1000)), nonce = randomBytes(18).toString("base64url");
  return {
    "x-omb-cloud-machine": access.machineId,
    "x-omb-cloud-timestamp": timestamp,
    "x-omb-cloud-nonce": nonce,
    "x-omb-cloud-signature": `v1=${pagesHomeSignature(access.secret, access.machineId, timestamp, nonce, body)}`,
  };
}

let desktopPages: { url: string; token: string } | null = null;
/** The desktop is signed in, but its Admin offers no pages for that sign-in yet. */
let desktopPagesNotOffered = false;

/** Security: the pages token goes only to the Admin over https, or to a loopback stand-in in development and tests. */
function adminUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname)) ? url.href : null;
  } catch {
    return null;
  }
}

/** `{ type: "openmausbot:included-pages", access: { url, token } | null }` from the desktop's main process. True when it
 * was one (then applied), false for any other message; a malformed one throws and changes nothing. */
export function applyIncludedPagesMessage(message: unknown): boolean {
  if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== "openmausbot:included-pages") return false;
  const access = (message as { access?: unknown }).access;
  if (access === null) {
    desktopPages = null;
    desktopPagesNotOffered = (message as { offered?: unknown }).offered === false;
    return true;
  }
  const { url, token } = (access && typeof access === "object" ? access : {}) as { url?: unknown; token?: unknown };
  const target = adminUrl(url);
  if (typeof token !== "string" || !/^omb_pd_[A-Za-z0-9_-]{43}$/.test(token) || !target) throw new Error("invalid pages access");
  desktopPages = { url: target, token };
  desktopPagesNotOffered = false;
  return true;
}

/** True when this desktop is signed in but its Admin offers no pages yet: the bot says so instead of asking to sign in. */
export function pagesNotOffered(home: unknown): boolean {
  return !home && !desktopPages && desktopPagesNotOffered;
}

/** A Cloud home's own credential, else a signed-in desktop's; null when this server is signed in to no MausBot account. */
export function pagesAccess(home: { adminOrigin: string; machineId: string; bootstrapSecret: string } | null): PagesAccess | null {
  if (home) return { kind: "home", url: `${home.adminOrigin}${PAGES_TOKEN_PATH}`, machineId: home.machineId, secret: home.bootstrapSecret };
  return desktopPages ? { kind: "desktop", ...desktopPages } : null;
}
