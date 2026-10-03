// The one `openmausbot://pair` link builder. The desktop's phone setup, the
// headless server's pairing endpoint and `openmausbot pair` all print this
// link; the Android and iOS scanners read it (android/core Connection.kt
// `PairingInvite.parse`, ios CompanionCore Client.swift `PairingInvite.parse`).
//
// Every value is written with encodeURIComponent, so a space is `%20`. The
// desktop used URLSearchParams until Oct 2026, which writes a space as `+`;
// neither phone read that back as a space, and "Miguel's computer" showed up
// as "Miguel's+computer". The phones now also read `+` as a space, for links
// from desktops still running the old builder.

export type CompanionEndpointKind = "hosted" | "tailnet" | "lan" | "bonjour";

export interface CompanionEndpoint {
  url: string;
  kind: CompanionEndpointKind;
  priority: number;
}

export interface PhonePairingLinkOptions {
  /** Where the phone dials first: a host or IP literal together with `port`
   * (the desktop companion), or a complete http(s) origin (a server). */
  address: string;
  port?: number;
  /** The high-entropy one-time credential the scanner redeems. */
  token: string;
  /** The six digits the desktop shows. Kept in the link so an older mobile
   * build can still pair during a staggered rollout; servers have none. */
  code?: string;
  name?: string;
  /** Every host the phone could dial later, best first. Older mobile builds
   * walk this list; current ones read `endpoints`. */
  hosts?: string[];
  /** Complete base URLs, encoded apart from `address`/`hosts` so HTTPS and
   * port 443 stay unambiguous. */
  endpoints?: CompanionEndpoint[];
  /** P-256 HPKE recipient key pinned by the camera scan. Its private half
   * remains in the desktop's OS-encrypted credential store. */
  secretPublicKey?: string;
}

/** How many fallback routes a link will carry. The list is tiny in practice;
 * the cap only keeps a pathological interface table from bloating the QR. */
export const MAX_PAIRING_HOSTS = 8;

const ENDPOINT_KINDS = new Set<CompanionEndpointKind>(["hosted", "tailnet", "lan", "bonjour"]);

/** Keep the QR contract strict even though its input came from our own
 * sidecar. A public URL with credentials or a path is not a companion base
 * URL, and filtering it is safer than teaching the phone to reinterpret it.
 * Sorted by priority, deduplicated by origin, capped. */
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
      // One malformed advisory route must not invalidate an otherwise usable
      // pairing QR. It is simply omitted from the route walk.
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
  code,
  name,
  hosts,
  endpoints,
  secretPublicKey,
}: PhonePairingLinkOptions): string | null {
  const dial = linkAddress(address, port);
  if (!dial || !/^omb_pair_[A-Za-z0-9_-]{43}$/.test(token)) return null;
  if (code !== undefined && !/^\d{6}$/.test(code)) return null;

  const fields: Array<[string, string]> = [["address", dial], ["token", token]];
  if (code !== undefined) fields.push(["code", code]);
  if (name?.trim()) fields.push(["name", name.trim()]);
  // Comma-joined, which no hostname or IP literal can contain. Filtered
  // rather than refused: a bad candidate costs the phone one failed dial,
  // and dropping the whole link over it would break pairing entirely.
  const candidates = (hosts ?? [])
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate && !/[\s/?#,[\]]/.test(candidate))
    .slice(0, MAX_PAIRING_HOSTS);
  if (candidates.length) fields.push(["hosts", candidates.join(",")]);
  const routes = qrEndpoints(endpoints);
  if (routes.length) fields.push(["endpoints", encodeEndpoints(routes)]);
  const secretKey = validSecretPublicKey(secretPublicKey);
  if (secretKey) fields.push(["secretKey", secretKey]);

  return `openmausbot://pair?${fields.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&")}`;
}
