import { qrEndpoints, type CompanionEndpoint } from "../../shared/pairing-link";

export type { CompanionEndpoint, CompanionEndpointKind } from "../../shared/pairing-link";

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

/** The address to type into a phone, written the way both phone apps read
 * it. A bare `host:port` is plain HTTP on that port to them, so a hosted
 * route shown as `abc.openmausbot.com:443` sent the typed code over HTTP to a
 * TLS port and failed on every phone. Hosted routes are written with their
 * scheme (and without the default port); direct routes keep `host:port`. */
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
  /** The exact protected transport selected when the QR was created. A
   * local-only route has no protected transport to retain. */
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

/** Select the route policy encoded into a QR. Automatic setup is deliberately
 * hosted-HTTPS only: Tailscale must be chosen explicitly and never replaces a
 * hosted route that is still provisioning. Explicit local setup leads with the
 * first LAN/Bonjour endpoint, then hosted, then this computer's other local
 * addresses (never a tailnet one). Both phones probe each of them, send the
 * one-time code only to the first in that order that answers as OpenMausBot,
 * and bind the device token to that one (ios Failover.swift
 * `pinRouteConsent`, android Connection.kt `pinningRouteConsent`). */
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
