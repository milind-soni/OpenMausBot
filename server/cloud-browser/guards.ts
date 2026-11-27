// What a browser in the Cloud's browser sandbox is kept from, at the home before a call reaches it: every bot's Chrome
// there runs as the same user, so a local page could read another bot's profile.
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

import { addressClass } from "../browser/egress/policy.ts";

/** Schemes that open what is on the sandbox's own disk or Chrome's own pages, never a website. */
const LOCAL_SCHEME = /^\s*(file|chrome|chrome-untrusted|devtools|view-source|filesystem|chrome-extension):/i;

export const LOCAL_SCHEME_REFUSAL = "This browser opens websites only: files and the browser's own pages (file:, chrome:, view-source: and the like) are not opened here.";

/** Any string in a call's arguments that names a local scheme, however deep. */
function namesLocal(value: unknown, depth = 0): boolean {
  if (typeof value === "string") return LOCAL_SCHEME.test(value);
  if (depth > 4 || !value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).some((item) => namesLocal(item, depth + 1));
}

/** The refusal for a tool call that would open a local scheme in the sandbox, or null. */
export function localSchemeRefusal(params: unknown): string | null {
  return namesLocal((params as { arguments?: unknown } | null)?.arguments) ? LOCAL_SCHEME_REFUSAL : null;
}

// The same address classes the home's own browsers are kept from (browser/egress/policy.ts): a browser in the sandbox has
// the sandbox's loopback (every bot's Chrome and its debugging port), the provider's metadata address and its network.
// Checked here for the addresses a call opens; the sandbox Chrome's own launch policy is what covers a page's own requests
// and redirects.

export const PRIVATE_ADDRESS_REFUSAL = "This browser opens public websites only: the browser computer's own services, local or private network addresses and cloud metadata addresses are not opened here.";

/** Names that are never a public website: loopback by rule, private-use and local top-level names, and the metadata services'. */
const LOCAL_NAME = /(?:^|\.)(?:localhost|local|localdomain|internal|intranet|lan|home\.arpa|corp)\.?$/i;
const METADATA_NAME = /^(?:metadata|metadata\.google\.internal|metadata\.goog|instance-data(?:\.ec2\.internal)?)\.?$/i;
const NETWORK_SCHEMES = new Set(["http:", "https:", "ws:", "wss:", "ftp:"]);
/** No address of this machine is "this machine" for a browser elsewhere: an empty list keeps every class as it is. */
const NO_OWN = new BlockList();
/** How long the home waits for its own resolver on a name: past it the call goes ahead, and the sandbox's policy decides. */
export const RESOLVE_MS = 1_500;
const RESOLVED_TTL_MS = 60_000;
const RESOLVED_MAX = 500;

export type Resolve = (host: string) => Promise<readonly string[]>;
const systemResolve: Resolve = async (host) => (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

/** The addresses a call opens: every `url` argument, however deep; one without a scheme is opened as https://. */
function opened(value: unknown, depth = 0, key = ""): string[] {
  if (typeof value === "string") return key === "url" ? [value] : [];
  if (depth > 4 || !value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([name, item]) => opened(item, depth + 1, Array.isArray(value) ? key : name));
}

function hostOf(raw: string): string | null {
  const text = raw.trim();
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`); } catch { return null; }
  if (!NETWORK_SCHEMES.has(url.protocol)) return null;
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase() || null;
}

const publicAddress = (address: string) => addressClass(address, NO_OWN) === "public";

/** The refusal for a tool call that would open a non-public address from the sandbox, or null. Names are resolved by the
 * home's own resolver (answers kept a minute), which may not answer as the sandbox's does. */
export function addressGuard(resolve: Resolve = systemResolve, now: () => number = Date.now, waitMs = RESOLVE_MS) {
  const resolved = new Map<string, { at: number; open: boolean }>();
  async function nameOpens(host: string): Promise<boolean> {
    const known = resolved.get(host);
    if (known && now() - known.at < RESOLVED_TTL_MS) return known.open;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((done) => { timer = setTimeout(() => done(null), waitMs); timer.unref?.(); });
    const addresses = await Promise.race([resolve(host).catch(() => null), late]).finally(() => clearTimeout(timer));
    // Not resolvable here (or not in time): the home cannot tell, so it does not refuse.
    if (addresses === null || addresses.length === 0) return true;
    const open = addresses.every(publicAddress);
    if (resolved.size >= RESOLVED_MAX) resolved.delete(resolved.keys().next().value!);
    resolved.set(host, { at: now(), open });
    return open;
  }
  return async (params: unknown): Promise<string | null> => {
    const hosts = opened((params as { arguments?: unknown } | null)?.arguments).map(hostOf).filter((host): host is string => host !== null);
    for (const host of hosts) {
      if (isIP(host)) { if (!publicAddress(host)) return PRIVATE_ADDRESS_REFUSAL; continue; }
      if (!host.includes(".") || LOCAL_NAME.test(host) || METADATA_NAME.test(host)) return PRIVATE_ADDRESS_REFUSAL;
      if (!await nameOpens(host.replace(/\.$/, ""))) return PRIVATE_ADDRESS_REFUSAL;
    }
    return null;
  };
}
