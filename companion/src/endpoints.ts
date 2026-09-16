import { lanAddresses, tailnetName, tailscaleAddress } from "./listener.ts";
import { defaultHostName } from "./mdns.ts";

export const COMPANION_ENDPOINT_KINDS = ["hosted", "tailnet", "lan", "bonjour"] as const;

export type CompanionEndpointKind = (typeof COMPANION_ENDPOINT_KINDS)[number];

/** A complete base URL the mobile app can dial, independent of the port and
 * transport assumptions made by the original `hosts` contract. */
export interface CompanionEndpoint {
  url: string;
  kind: CompanionEndpointKind;
  priority: number;
}

export const MAX_COMPANION_ENDPOINTS = 8;

/** Read the deliberately narrow hosted-route setting.
 *
 * A hosted endpoint is public internet infrastructure, so accepting a typo
 * as though it were a local route is worse than refusing to start. It must be
 * an HTTPS origin: paths, credentials, queries, and fragments have no place
 * in a base URL and make request construction ambiguous. */
export function hostedCompanionUrl(value: string | undefined): string | null {
  const configured = value?.trim();
  if (!configured) return null;

  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error("ASTRA_COMPANION_HOSTED_URL must be an absolute HTTPS origin");
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("ASTRA_COMPANION_HOSTED_URL must be an HTTPS origin without a path, credentials, query, or fragment");
  }

  return parsed.origin;
}

const httpOrigin = (host: string, port: number): string => {
  const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${authority}:${port}`;
};

/** Every complete URL a new mobile build can dial, best first.
 *
 * The hosted HTTPS route wins when configured. Direct routes remain in the
 * same order as the legacy host list so the app can fall back without an
 * account, relay, or Tailscale dependency. The final cap bounds both QR size
 * and connection-walk latency; Bonjour is retained as the last fallback even
 * on a machine with an unusually large interface table. */
export function companionEndpointCandidates(
  port: number,
  addresses: string[] = lanAddresses(),
  magicDnsName: string | null = tailnetName(),
  hostedUrl: string | null = null,
  bonjourHost: string = defaultHostName(),
): CompanionEndpoint[] {
  const tailscale = tailscaleAddress(addresses);
  const candidates: CompanionEndpoint[] = [];

  if (hostedUrl) candidates.push({ url: hostedUrl, kind: "hosted", priority: 0 });
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
