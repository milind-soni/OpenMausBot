import { qrEndpoints, type CompanionEndpoint } from "../../shared/pairing-link";

export type { CompanionEndpoint, CompanionEndpointKind } from "../../shared/pairing-link";

export type CompanionPairingRouteMode = "automatic" | "local" | "tailscale";

export interface CompanionPairingRouteSource {
  port: number;
  addresses?: string[];
  tailscale?: string;
  tailnetName?: string;
  /** The per-route switches from Settings; the sidecar's tailnetName can lag them. */
  routes?: { tailscale?: { on: boolean; name?: string | null } };
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

/** Both phone apps read a bare `host:port` as plain HTTP, so hosted routes carry their scheme. */
export function companionPairingAddressText(route: CompanionPairingRoute): string {
  const hosted = route.endpoints?.find((endpoint) => {
    if (endpoint.kind !== "hosted") return false;
    try {
      return new URL(endpoint.url).hostname === route.address;
    } catch {
      return false;
    }
  });
  if (hosted) return new URL(hosted.url).origin;
  return `${route.address}:${route.port}`;
}

export interface CompanionPairingRoutePin {
  route: CompanionPairingRoute;
  protectedEndpoint: CompanionEndpoint | null;
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

/** Automatic setup is hosted-HTTPS only; Tailscale must be chosen explicitly and never replaces a provisioning hosted route. */
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
      // Older phone builds assume cleartext HTTP for every legacy host, so a hosted TLS authority fails closed.
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
    if (!preferred && source.routes?.tailscale?.on) {
      const routeName = source.routes.tailscale.name?.trim();
      if (routeName) {
        preferred = qrEndpoints([{
          url: directHTTPOrigin(routeName, source.port),
          kind: "tailnet",
          priority: 0,
        }])[0] ?? null;
      }
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
      // Legacy clients walk `hosts` untyped: no cleartext LAN fallbacks where the one-time credential could be replayed.
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
    hosts: deduplicatedHosts([
      address,
      ...(source.hosts ?? []).filter((host) =>
        !host.trim().toLowerCase().replace(/\.$/, "").endsWith(".ts.net")
      ),
    ]),
    endpoints,
  };
}

/** Frozen per QR, so a later refresh cannot reinterpret the one-time credential as Tailscale or plain LAN. */
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

/** No silent substitution of another protected endpoint: a new transport needs a fresh pairing credential. */
export function companionPairingRoutePinAvailable(
  source: Pick<CompanionPairingRouteSource, "endpoints" | "routes">,
  pin: CompanionPairingRoutePin,
): boolean {
  if (!pin.protectedEndpoint) return true;
  if (qrEndpoints(source.endpoints).some(
    (endpoint) => endpoint.kind === pin.protectedEndpoint?.kind
      && endpoint.url === pin.protectedEndpoint.url,
  )) return true;
  if (pin.protectedEndpoint.kind !== "tailnet") return false;
  const routeName = source.routes?.tailscale?.on
    ? source.routes.tailscale.name?.trim().toLowerCase().replace(/\.$/, "")
    : undefined;
  if (!routeName) return false;
  try {
    return new URL(pin.protectedEndpoint.url).hostname.toLowerCase().replace(/\.$/, "") === routeName;
  } catch {
    return false;
  }
}
