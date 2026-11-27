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

// What a tool call for a browser in the sandbox may open, checked at the home before the call reaches it: the same address
// classes the home's own browsers are kept from (browser/egress/policy.ts), since the sandbox has its own loopback (every
// bot's Chrome and its debugging port), the provider's metadata address and its network. This checks only the call's own
// `url` arguments. It does not stop a page's redirects or its own requests, a link a bot clicks, script a bot runs in a
// page, or a name that resolves differently at the provider than here: nothing in the sandbox's Chrome blocks those today
// (its managed policy blocks only file://, chrome://, chrome-untrusted://, devtools:// and view-source:).

export const PRIVATE_ADDRESS_REFUSAL = "This browser opens public websites only: the browser computer's own services, local or private network addresses and cloud metadata addresses are not opened here.";
export const UNREADABLE_ADDRESS_REFUSAL = "This browser could not read that address. Give the full address, starting with https://.";

/** Names that are never a public website: loopback by rule, private-use and local top-level names, and the metadata services'. */
const LOCAL_NAME = /(?:^|\.)(?:localhost|local|localdomain|internal|intranet|lan|home\.arpa|corp)\.?$/i;
const METADATA_NAME = /^(?:metadata|metadata\.google\.internal|metadata\.goog|instance-data(?:\.ec2\.internal)?)\.?$/i;
const NETWORK_SCHEMES = new Set(["http:", "https:", "ws:", "wss:", "ftp:"]);
/** No address of this machine is "this machine" for a browser elsewhere: an empty list keeps every class as it is. */
const NO_OWN = new BlockList();
/** How long a call waits for the home's resolver on a name not asked in the last minute: past it the call goes ahead, and
 * the answer, when it comes, is kept for the rest of that minute. */
export const RESOLVE_MS = 1_500;
const RESOLVED_TTL_MS = 60_000;
const RESOLVED_MAX = 500;
/** Deeper than any tool's arguments go. */
const MAX_DEPTH = 12;

export type Resolve = (host: string) => Promise<readonly string[]>;
const systemResolve: Resolve = async (host) => (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

/** The addresses a call opens: every `url` argument, however deep. */
function opened(value: unknown, depth = 0, key = ""): string[] {
  if (typeof value === "string") return key === "url" ? [value] : [];
  if (depth > MAX_DEPTH || !value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([name, item]) => opened(item, depth + 1, Array.isArray(value) ? key : name));
}

/** The host a `url` value opens: written with a scheme (`http:127.0.0.1` included) it is read as it is; without one (or as
 * `host:port`) it is opened as https://. A value that is no address at all (about:blank, data:) opens no host. */
function hostOf(raw: string): { host: string } | "none" | "unreadable" {
  const text = raw.trim();
  if (!text) return "none";
  const hostAndPort = /^[a-z0-9.-]+:\d+(?:[/?#]|$)/i.test(text);
  const schemed = !hostAndPort && /^[a-z][a-z0-9+.-]*:/i.test(text);
  let url: URL;
  try { url = new URL(schemed ? text : `https://${text}`); } catch { return "unreadable"; }
  if (!NETWORK_SCHEMES.has(url.protocol)) return "none";
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host ? { host } : "unreadable";
}

const publicAddress = (address: string) => addressClass(address, NO_OWN) === "public";

/** The refusal for a tool call that would open a non-public address from the sandbox, or null. Names are resolved by the
 * home's own resolver, all of a call's at once; answers (a failed one too) are kept a minute, and a late one is kept for
 * that minute when it comes. */
export function addressGuard(resolve: Resolve = systemResolve, now: () => number = Date.now, waitMs = RESOLVE_MS) {
  const resolved = new Map<string, { at: number; open?: boolean }>();
  async function nameOpens(host: string): Promise<boolean> {
    const known = resolved.get(host);
    // Still unanswered from an earlier call: not waited for again (the home cannot tell yet).
    if (known && now() - known.at < RESOLVED_TTL_MS) return known.open ?? true;
    const entry: { at: number; open?: boolean } = { at: now() };
    if (resolved.size >= RESOLVED_MAX) resolved.delete(resolved.keys().next().value!);
    resolved.set(host, entry);
    // Not resolvable here: the home cannot tell, so it does not refuse.
    const answer = resolve(host).then((addresses) => addresses.every(publicAddress), () => true)
      .then((open) => { entry.open = open; return open; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((done) => { timer = setTimeout(() => done(null), waitMs); timer.unref?.(); });
    const open = await Promise.race([answer, late]).finally(() => clearTimeout(timer));
    return open ?? true;
  }
  return async (params: unknown): Promise<string | null> => {
    const names = new Set<string>();
    for (const raw of opened((params as { arguments?: unknown } | null)?.arguments)) {
      const read = hostOf(raw);
      if (read === "none") continue;
      if (read === "unreadable") return UNREADABLE_ADDRESS_REFUSAL;
      const { host } = read;
      if (isIP(host)) { if (!publicAddress(host)) return PRIVATE_ADDRESS_REFUSAL; continue; }
      if (!host.includes(".") || LOCAL_NAME.test(host) || METADATA_NAME.test(host)) return PRIVATE_ADDRESS_REFUSAL;
      names.add(host.replace(/\.$/, ""));
    }
    const answers = await Promise.all([...names].map(nameOpens));
    return answers.every(Boolean) ? null : PRIVATE_ADDRESS_REFUSAL;
  };
}
