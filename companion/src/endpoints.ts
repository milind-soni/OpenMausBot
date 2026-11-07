import { lanAddresses, tailnetName, tailscaleAddress } from "./listener.ts";
import { defaultHostName } from "./mdns.ts";

export const COMPANION_ENDPOINT_KINDS = ["hosted", "tailnet", "lan", "bonjour"] as const;

export type CompanionEndpointKind = (typeof COMPANION_ENDPOINT_KINDS)[number];

/** A complete base URL the mobile app can dial. */
export interface CompanionEndpoint {
  url: string;
  kind: CompanionEndpointKind;
  priority: number;
}

export const MAX_COMPANION_ENDPOINTS = 8;

/** A hosted endpoint is public internet infrastructure, so a typo refuses to
 * start rather than pass as a local route. It must be a bare HTTPS origin. */
export function hostedCompanionUrl(value: string | undefined): string | null {
  const configured = value?.trim();
  if (!configured) return null;

  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error("OMB_COMPANION_HOSTED_URL must be an absolute HTTPS origin");
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("OMB_COMPANION_HOSTED_URL must be an HTTPS origin without a path, credentials, query, or fragment");
  }

  return parsed.origin;
}

const httpOrigin = (host: string, port: number): string => {
  const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${authority}:${port}`;
};

/** Best first: the hosted HTTPS route when configured, the tailnet's HTTPS
 * route while Tailscale is on, then the direct routes
 * in the host list's order, Bonjour last. The cap bounds QR size and the
 * connection walk. */
export function companionEndpointCandidates(
  port: number,
  addresses: string[] = lanAddresses(),
  magicDnsName: string | null = tailnetName(),
  hostedUrl: string | null = null,
  bonjourHost: string = defaultHostName(),
  tailnetHttps: string | null = null,
): CompanionEndpoint[] {
  const tailscale = tailscaleAddress(addresses);
  const candidates: CompanionEndpoint[] = [];

  if (hostedUrl) candidates.push({ url: hostedUrl, kind: "hosted", priority: 0 });
  if (tailnetHttps) candidates.push({ url: tailnetHttps, kind: "tailnet", priority: 90 });
  if (tailscale && magicDnsName) {
    candidates.push({ url: httpOrigin(magicDnsName, port), kind: "tailnet", priority: 100 });
  }
  addresses.forEach((address, index) => {
    if (address !== tailscale) {
      candidates.push({ url: httpOrigin(address, port), kind: "lan", priority: 200 + index });
    }
  });
  candidates.push({ url: httpOrigin(bonjourHost, port), kind: "bonjour", priority: 300 });

  const seen = new Set<string>();
  const ordered = candidates
    .sort((left, right) => left.priority - right.priority)
    .filter((endpoint) => {
      if (seen.has(endpoint.url)) return false;
      seen.add(endpoint.url);
      return true;
    });

  if (ordered.length <= MAX_COMPANION_ENDPOINTS) return ordered;
  const bonjour = ordered.find((endpoint) => endpoint.kind === "bonjour");
  const head = ordered.filter((endpoint) => endpoint.kind !== "bonjour").slice(0, MAX_COMPANION_ENDPOINTS - 1);
  return bonjour ? [...head, bonjour] : ordered.slice(0, MAX_COMPANION_ENDPOINTS);
}
