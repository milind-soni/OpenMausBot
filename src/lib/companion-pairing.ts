interface CompanionPairingLinkOptions {
  address: string;
  port: number;
  code: string;
  token: string;
  name?: string;
  /** Every host the phone could dial later, best first. Carried alongside
   * `address` so the app can fall back when the paired host stops resolving
   * — a tailnet name is unreachable the moment the phone leaves the tailnet,
   * while the LAN address keeps working. Older mobile builds ignore it. */
  hosts?: string[];
  /** Complete base URLs for current mobile builds. Encoded separately from
   * the legacy address/hosts fields so HTTPS and port 443 stay unambiguous. */
  endpoints?: CompanionEndpoint[];
  /** P-256 HPKE recipient key pinned by the camera scan. Its private half
   * remains in the desktop's OS-encrypted credential store. */
  secretPublicKey?: string;
}

export type CompanionEndpointKind = "hosted" | "tailnet" | "lan" | "bonjour";

export interface CompanionEndpoint {
  url: string;
  kind: CompanionEndpointKind;
  priority: number;
}

export type CompanionPairingRouteMode = "automatic" | "local" | "tailscale";

export interface CompanionPairingRouteSource {
  port: number;
  addresses?: string[];
  tailscale?: string;
  tailnetName?: string;
  lan?: string | null;
  hosts?: string[];
  endpoints?: CompanionEndpoint[];
  discovery?: { advertising: boolean; name: string };
}

export interface CompanionPairingRoute {
  address: string;
  port: number;
  hosts?: string[];
  endpoints?: CompanionEndpoint[];
}

export interface CompanionPairingRoutePin {
  route: CompanionPairingRoute;
  /** The exact protected transport selected when the QR was created. A
   * local-only route has no protected transport to retain. */
  protectedEndpoint: CompanionEndpoint | null;
}

/** How many fallback hosts a link will carry. The list is tiny in practice
 * (tailnet name, a LAN address or two, the mDNS name); the cap only keeps a
 * pathological interface list from bloating the QR code. */
const MAX_HOSTS = 8;
const ENDPOINT_KINDS = new Set<CompanionEndpointKind>(["hosted", "tailnet", "lan", "bonjour"]);

/** Keep the QR contract strict even though its input came from our own
 * sidecar. A public URL with credentials or a path is not a companion base
 * URL, and filtering it is safer than teaching the phone to reinterpret it. */
function qrEndpoints(endpoints: CompanionEndpoint[] | undefined): CompanionEndpoint[] {
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

  return valid.sort((left, right) => left.priority - right.priority).slice(0, MAX_HOSTS);
}

const deduplicatedHosts = (hosts: string[]): string[] => {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const host of hosts) {
    const normalized = host.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    values.push(normalized);
  }
  return values;
};

const directHTTPOrigin = (host: string, port: number): string => {
  const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${authority}:${port}`;
};

/** Select the route policy encoded into a QR. Automatic setup is deliberately
 * hosted-HTTPS only: Tailscale must be chosen explicitly and never replaces a
 * hosted route that is still provisioning. Explicit local setup promotes one
 * exact LAN/Bonjour endpoint, followed only by hosted upgrades; iOS then
 * refuses to spray the pairing credential onto any other cleartext route. */
export function companionPairingRoute(
  source: CompanionPairingRouteSource,
  mode: CompanionPairingRouteMode,
): CompanionPairingRoute | null {
  if (mode === "automatic") {
    const hosted = qrEndpoints(source.endpoints).filter((endpoint) => endpoint.kind === "hosted");
    const preferred = hosted[0] ?? null;
    if (!preferred) return null;

    const parsed = new URL(preferred.url);
    const address = parsed.hostname;
    const port = parsed.port ? Number(parsed.port) : 443;
    return {
      address,
      port,
      // Older phone builds ignore typed endpoints and assume cleartext HTTP
      // for every legacy host. A hosted authority on its TLS port therefore
      // fails closed instead of replaying the credential to Tailscale or LAN.
      hosts: deduplicatedHosts([
        address,
        ...hosted.map((endpoint) => new URL(endpoint.url).hostname),
      ]),
      endpoints: hosted,
    };
  }

  const advertised = qrEndpoints(source.endpoints);
  if (mode === "tailscale") {
    let preferred = advertised.find((endpoint) => endpoint.kind === "tailnet") ?? null;
    if (!preferred && source.tailnetName?.trim()) {
      preferred = qrEndpoints([{
        url: directHTTPOrigin(source.tailnetName.trim(), source.port),
        kind: "tailnet",
        priority: 0,
      }])[0] ?? null;
    }
    if (!preferred) return null;

    const parsed = new URL(preferred.url);
    const address = parsed.hostname;
    const port = parsed.port ? Number(parsed.port) : 80;
    const protectedRoutes = advertised.filter(
      (endpoint) => endpoint.url !== preferred.url && ["hosted", "tailnet"].includes(endpoint.kind),
    );
    const endpoints = [preferred, ...protectedRoutes].map((endpoint, index) => ({
      ...endpoint,
      priority: index * 100,
    }));
    return {
      address,
      port,
      // Legacy clients walk `hosts` without typed transport policy. Keep a
      // Tailscale-only QR from carrying LAN/Bonjour cleartext fallbacks where
      // its one-time credential could otherwise be replayed.
      hosts: deduplicatedHosts([
        address,
        ...(source.hosts ?? []).filter((host) =>
          host.trim().toLowerCase().replace(/\.$/, "").endsWith(".ts.net")
        ),
      ]),
      endpoints,
    };
  }

  let preferred = advertised.find((endpoint) => endpoint.kind === "lan")
    ?? (source.discovery?.advertising
      ? advertised.find((endpoint) => endpoint.kind === "bonjour")
      : null)
    ?? null;
  if (!preferred) {
    const fallbackHost = source.lan?.trim()
      || (source.discovery?.advertising
        ? source.hosts?.find((host) => host.trim().toLowerCase().endsWith(".local"))
        : null);
    if (!fallbackHost) return null;
    preferred = qrEndpoints([{
      url: directHTTPOrigin(fallbackHost.trim(), source.port),
      kind: fallbackHost.trim().toLowerCase().endsWith(".local") ? "bonjour" : "lan",
      priority: 0,
    }])[0] ?? null;
  }
  if (!preferred) return null;

  const parsed = new URL(preferred.url);
  const address = parsed.hostname;
  const port = parsed.port ? Number(parsed.port) : 80;
  const protectedRoutes = advertised.filter(
    (endpoint) => endpoint.url !== preferred.url && endpoint.kind === "hosted",
  );
  const otherLocalRoutes = advertised.filter(
    (endpoint) => endpoint.url !== preferred.url && !["hosted", "tailnet"].includes(endpoint.kind),
  );
  const endpoints = [preferred, ...protectedRoutes, ...otherLocalRoutes].map((endpoint, index) => ({
    ...endpoint,
    priority: index * 100,
  }));
  return {
    address,
    port,
    // Choosing local must not smuggle a tailnet route into legacy clients.
    // Tailscale has its own explicit mode and consent copy.
    hosts: deduplicatedHosts([
      address,
      ...(source.hosts ?? []).filter((host) =>
        !host.trim().toLowerCase().replace(/\.$/, "").endsWith(".ts.net")
      ),
    ]),
    endpoints,
  };
}

/** Freeze the route represented by one pairing QR. Automatic setup must have
 * a validated hosted endpoint; otherwise a later state refresh cannot
 * reinterpret the same one-time credential as Tailscale or plain LAN. */
export function companionPairingRoutePin(
  source: CompanionPairingRouteSource,
  mode: CompanionPairingRouteMode,
): CompanionPairingRoutePin | null {
  const route = companionPairingRoute(source, mode);
  if (!route) return null;

  const endpoints = qrEndpoints(route.endpoints);
  const firstEndpoint = endpoints[0] ?? null;
  const protectedEndpoint = mode === "local"
    ? null
    : mode === "tailscale"
      ? endpoints.find((endpoint) => endpoint.kind === "tailnet") ?? null
      : firstEndpoint?.kind === "hosted"
        ? firstEndpoint
        : null;
  if (mode !== "local" && !protectedEndpoint) return null;

  return {
    route: { ...route, endpoints },
    protectedEndpoint,
  };
}

/** A pinned secure QR remains valid only while its exact chosen transport is
 * still advertised. Another protected endpoint is not silently substituted:
 * changing transport requires a fresh pairing attempt and credential. */
export function companionPairingRoutePinAvailable(
  source: Pick<CompanionPairingRouteSource, "endpoints">,
  pin: CompanionPairingRoutePin,
): boolean {
  if (!pin.protectedEndpoint) return true;
  return qrEndpoints(source.endpoints).some(
    (endpoint) => endpoint.kind === pin.protectedEndpoint?.kind
      && endpoint.url === pin.protectedEndpoint.url,
  );
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

/**
 * A short-lived handoff from the trusted desktop pairing panel to the mobile
 * app. The code still has to be redeemed with the companion; putting it in
 * the link does not create or expose the long-lived device token.
 */
export function companionPairingLink({
  address,
  port,
  code,
  token,
  name,
  hosts,
  endpoints,
  secretPublicKey,
}: CompanionPairingLinkOptions): string | null {
  const host = address.trim();
  if (
    !host ||
    !/^\d{6}$/.test(code) ||
    !/^omb_pair_[A-Za-z0-9_-]{43}$/.test(token) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  )
    return null;
  const dialableHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

  const url = new URL("openmausbot://pair");
  url.searchParams.set("address", `${dialableHost}:${port}`);
  // The scanner uses the high-entropy token. The code remains in the link so
  // an older mobile build can still pair during a staggered desktop rollout.
  url.searchParams.set("token", token);
  url.searchParams.set("code", code);
  if (name?.trim()) url.searchParams.set("name", name.trim());
  // Comma-joined, which no hostname or IP literal can contain. Filtered
  // rather than refused: a bad candidate costs the phone one failed dial,
  // and dropping the whole link over it would break pairing entirely.
  const candidates = (hosts ?? [])
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate && !/[\s/?#,[\]]/.test(candidate))
    .slice(0, MAX_HOSTS);
  if (candidates.length) url.searchParams.set("hosts", candidates.join(","));
  const routes = qrEndpoints(endpoints);
  if (routes.length) url.searchParams.set("endpoints", encodeEndpoints(routes));
  const secretKey = validSecretPublicKey(secretPublicKey);
  if (secretKey) url.searchParams.set("secretKey", secretKey);
  return url.toString();
}
