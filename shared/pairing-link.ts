// The one `openmausbot://pair` link builder, read by the Android and iOS
// scanners (`PairingInvite.parse`). Every value is written with
// encodeURIComponent, so a space is `%20`.

export type CompanionEndpointKind = "hosted" | "tailnet" | "lan" | "bonjour";

export interface CompanionEndpoint {
  url: string;
  kind: CompanionEndpointKind;
  priority: number;
}

export interface PairingE2EDescriptor {
  v: 1;
  k: string;
  h?: string;
  r?: string[];
}

const B64U_FIELD = /^[A-Za-z0-9_-]+$/;
const RELAY_HOST = /^relay[1-9][0-9]?\.openmausbot\.com$/;

/** The QR's `e2e` value, or null for anything a phone would refuse: then the link goes out without it, as from a
 * computer without the encrypted connection. A QR never says "local": a restriction is set per phone, later. */
export function encodePairingE2E(descriptor: PairingE2EDescriptor | null | undefined): string | null {
  if (!descriptor || descriptor.v !== 1 || typeof descriptor.k !== "string" || descriptor.k.length !== 87 || !B64U_FIELD.test(descriptor.k)) return null;
  const relay = typeof descriptor.h === "string" && Array.isArray(descriptor.r) && descriptor.r.length >= 1 && descriptor.r.length <= 4
    && descriptor.h.length === 22 && B64U_FIELD.test(descriptor.h) && descriptor.r.every((node) => RELAY_HOST.test(node))
    ? { h: descriptor.h, r: descriptor.r }
    : {};
  const json = JSON.stringify({ v: 1, k: descriptor.k, ...relay });
  const encoded = btoa(json).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return encoded.length <= 1024 ? encoded : null;
}

export interface PhonePairingLinkOptions {
  /** Where the phone dials first: a host or IP literal together with `port`
   * (the desktop companion), or a complete http(s) origin (a server). */
  address: string;
  port?: number;
  /** The high-entropy one-time credential the scanner redeems. */
  token: string;
  name?: string;
  /** Every host the phone could dial later, best first. */
  hosts?: string[];
  /** Complete base URLs, encoded apart from `address`/`hosts` so HTTPS and
   * port 443 stay unambiguous. */
  endpoints?: CompanionEndpoint[];
  /** The end-to-end descriptor `{v, k, h?, r?}`: the computer's transport key, pinned by the scan, and its relay
   * identity. Sent as `e2e=<base64url JSON>`; a phone that can't parse it refuses the whole link. */
  e2e?: PairingE2EDescriptor | null;
  /** P-256 HPKE recipient key pinned by the camera scan. Its private half
   * remains in the desktop's OS-encrypted credential store. */
  secretPublicKey?: string;
}

/** How many fallback routes a link will carry. The list is tiny in practice;
 * the cap only keeps a pathological interface table from bloating the QR. */
export const MAX_PAIRING_HOSTS = 8;

const ENDPOINT_KINDS = new Set<CompanionEndpointKind>(["hosted", "tailnet", "lan", "bonjour"]);

/** Strict even for our own sidecar's input: a public URL with credentials or a
 * path is not a companion base URL. Sorted by priority, deduplicated by origin,
 * capped. */
export function qrEndpoints(endpoints: CompanionEndpoint[] | undefined): CompanionEndpoint[] {
  const seen = new Set<string>();
  const valid: CompanionEndpoint[] = [];

  for (const endpoint of endpoints ?? []) {
    if (
      !endpoint ||
      !ENDPOINT_KINDS.has(endpoint.kind) ||
      !Number.isInteger(endpoint.priority) ||
      endpoint.priority < 0 ||
      endpoint.priority > 1_000_000
    ) {
      continue;
    }

    try {
      const parsed = new URL(endpoint.url);
      const expectedProtocol = endpoint.kind === "hosted" ? "https:" : "http:";
      const explicitPort = parsed.port ? Number(parsed.port) : null;
      const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
      if (
        parsed.protocol !== expectedProtocol ||
        // No empty DNS label (".ts.net", "mac..local"): the phones refuse
        // one, and one endpoint they refuse makes them refuse the whole QR.
        hostname.split(".").includes("") ||
        (endpoint.kind === "tailnet" && !hostname.endsWith(".ts.net")) ||
        (explicitPort !== null && (!Number.isInteger(explicitPort) || explicitPort < 1 || explicitPort > 65_535)) ||
        parsed.username ||
        parsed.password ||
        parsed.pathname !== "/" ||
        parsed.search ||
        parsed.hash ||
        seen.has(parsed.origin)
      ) {
        continue;
      }
      seen.add(parsed.origin);
      valid.push({ url: parsed.origin, kind: endpoint.kind, priority: endpoint.priority });
    } catch {
    }
  }

  return valid.sort((left, right) => left.priority - right.priority).slice(0, MAX_PAIRING_HOSTS);
}

/** URL-safe, unpadded base64 keeps the structured JSON smaller than query
 * escaping every quote and slash while remaining straightforward to decode
 * with Foundation on iOS. */
function encodeEndpoints(endpoints: CompanionEndpoint[]): string {
  const bytes = new TextEncoder().encode(JSON.stringify(endpoints));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function validSecretPublicKey(value: string | undefined): string | null {
  if (!value || !/^[A-Za-z0-9_-]{87}$/.test(value)) return null;
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/") + "=";
    const decoded = atob(base64);
    if (decoded.length !== 65 || decoded.charCodeAt(0) !== 4) return null;
    let binary = "";
    for (let index = 0; index < decoded.length; index += 1) binary += decoded[index];
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") === value
      ? value
      : null;
  } catch {
    return null;
  }
}

/** The `address` value: `host:port` (IPv6 bracketed) or a bare http(s)
 * origin, or null when it is neither. Both phones refuse an address with
 * credentials, a path, a query or a fragment, as `qrEndpoints` does. */
function linkAddress(address: string, port: number | undefined): string | null {
  const value = address.trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
      return parsed.origin;
    } catch {
      return null;
    }
  }
  if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  const authority = value.includes(":") && !value.startsWith("[") ? `[${value}]` : value;
  return `${authority}:${port}`;
}

/**
 * A short-lived handoff from a trusted pairing screen to the mobile app. The
 * credential still has to be redeemed; putting it in the link does not
 * create or expose the long-lived device token. Null when any required part
 * is malformed, so a caller never prints a link a phone would refuse.
 */
export function phonePairingLink({
  address,
  port,
  token,
  name,
  hosts,
  endpoints,
  secretPublicKey,
  e2e,
}: PhonePairingLinkOptions): string | null {
  const dial = linkAddress(address, port);
  if (!dial || !/^omb_pair_[A-Za-z0-9_-]{43}$/.test(token)) return null;

  const fields: Array<[string, string]> = [["address", dial], ["token", token]];
  if (name?.trim()) fields.push(["name", name.trim()]);
  // Comma-joined, which no hostname or IP literal can contain. A bad candidate
  // is filtered, not fatal: it costs the phone one failed dial.
  const candidates = (hosts ?? [])
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate && !/[\s/?#,[\]]/.test(candidate))
    .slice(0, MAX_PAIRING_HOSTS);
  if (candidates.length) fields.push(["hosts", candidates.join(",")]);
  const routes = qrEndpoints(endpoints);
  if (routes.length) fields.push(["endpoints", encodeEndpoints(routes)]);
  const secretKey = validSecretPublicKey(secretPublicKey);
  if (secretKey) fields.push(["secretKey", secretKey]);
  const descriptor = encodePairingE2E(e2e);
  if (descriptor) fields.push(["e2e", descriptor]);

  return `openmausbot://pair?${fields.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&")}`;
}
