// Which direct ways in are on: Same Wi-Fi (this computer's LAN addresses and Bonjour) and Tailscale (its tailnet
// address). The desktop app decides; a sidecar standing alone serves Same Wi-Fi unless told otherwise.
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";

import { lanAddresses, setTailnetName } from "./listener.ts";

export interface DirectRoutes {
  wifi: boolean;
  tailscale: boolean;
  tailnetName: string | null;
}

const TAILNET_NAME = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net$/i;

let current: DirectRoutes = { wifi: true, tailscale: false, tailnetName: null };

export function directRoutes(): DirectRoutes {
  return current;
}

/** Unknown input keeps the field as it was; a name is kept only if it looks like a MagicDNS name. */
export function setDirectRoutes(next: { wifi?: unknown; tailscale?: unknown; tailnetName?: unknown }): DirectRoutes {
  const name = typeof next.tailnetName === "string" && TAILNET_NAME.test(next.tailnetName) ? next.tailnetName.toLowerCase() : next.tailnetName === null ? null : current.tailnetName;
  current = {
    wifi: typeof next.wifi === "boolean" ? next.wifi : current.wifi,
    tailscale: typeof next.tailscale === "boolean" ? next.tailscale : current.tailscale,
    tailnetName: name,
  };
  setTailnetName(current.tailscale ? current.tailnetName : null);
  return current;
}

/** `OMB_COMPANION_ROUTES` is a comma list of `wifi` and `tailscale` (empty for neither); unset means Same Wi-Fi. */
export function directRoutesFromEnv(env: NodeJS.ProcessEnv): DirectRoutes {
  const listed = env.OMB_COMPANION_ROUTES;
  const names = listed === undefined ? ["wifi"] : listed.split(",").map((part) => part.trim().toLowerCase());
  return setDirectRoutes({
    wifi: names.includes("wifi"),
    tailscale: names.includes("tailscale"),
    tailnetName: env.OMB_COMPANION_TAILNET_NAME ?? null,
  });
}

export const anyDirectRoute = (routes = current): boolean => routes.wifi || routes.tailscale;

const bare = (address: string): string => (address.startsWith("::ffff:") ? address.slice(7) : address).replace(/%.*$/, "").toLowerCase();

const TAILSCALE_V6 = /^fd7a:115c:a1e0:/i;

/** Tailscale's own interface: `tailscale0` on Linux, "Tailscale" on Windows, and on macOS the utun that carries a
 * fd7a:115c:a1e0::/48 address. Never any 100.64/10 address alone: carrier NAT and other VPNs use that range too. */
export function tailnetInterfaceAddresses(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): Set<string> {
  const found = new Set<string>();
  for (const [name, entries] of Object.entries(interfaces)) {
    const list = entries ?? [];
    if (/^tailscale/i.test(name) || list.some((entry) => TAILSCALE_V6.test(entry.address))) {
      for (const entry of list) found.add(bare(entry.address));
    }
  }
  return found;
}

export function isTailnetAddress(address: string | undefined, tailnet: Set<string> = tailnetInterfaceAddresses()): boolean {
  return Boolean(address) && tailnet.has(bare(address!));
}

/** A tailnet peer's own address: Tailscale's ranges, 100.64.0.0/10 and fd7a:115c:a1e0::/48. */
const inTailscaleRange = (address: string): boolean => {
  if (isIP(address) === 4) {
    const [first, second] = address.split(".").map(Number);
    return first === 100 && second >= 64 && second <= 127;
  }
  return TAILSCALE_V6.test(address);
};

/** Loopback, RFC 1918, link-local, or fd00::/8. */
export function isPrivateLanAddress(address: string | undefined): boolean {
  if (!address) return false;
  const value = bare(address);
  if (isIP(value) === 4) {
    const [a, b] = value.split(".").map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return value === "::1" || /^fe[89ab][0-9a-f]:/i.test(value) || /^fd[0-9a-f]{2}:/i.test(value);
}

const isLoopback = (address: string) => address === "127.0.0.1" || address === "::1" || address.startsWith("::ffff:127.");

/** The addresses this computer offers devices: the tailnet one only with Tailscale on, the rest only with Same Wi-Fi. */
export function routedAddresses(addresses: string[] = lanAddresses(), routes = current, tailnet = tailnetInterfaceAddresses()): string[] {
  return addresses.filter((address) => (isTailnetAddress(address, tailnet) ? routes.tailscale : routes.wifi && isPrivateLanAddress(address)));
}

/**
 * Security: the device port binds every interface, so a connection is answered only when both ends are private and it
 * arrived on a way in that is on: on the tailnet interface from a tailnet peer with Tailscale on, or on a private LAN
 * address from a private LAN peer with Same Wi-Fi on. A public peer is refused on any way in.
 */
export function acceptsConnection(localAddress: string | undefined, remoteAddress: string | undefined, routes = current, tailnet = tailnetInterfaceAddresses()): boolean {
  if (!localAddress || !remoteAddress) return false;
  const local = bare(localAddress);
  const remote = bare(remoteAddress);
  if (isLoopback(local)) return isLoopback(remote);
  if (isTailnetAddress(local, tailnet)) return routes.tailscale && inTailscaleRange(remote);
  return routes.wifi && isPrivateLanAddress(local) && isPrivateLanAddress(remote) && !isLoopback(remote);
}
