// Which direct ways in are on: Same Wi-Fi (this computer's LAN addresses and Bonjour) and Tailscale (its tailnet
// address). The desktop app decides; a sidecar standing alone serves Same Wi-Fi unless told otherwise.
import { isIP } from "node:net";

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

/** Tailscale's ranges: 100.64.0.0/10 (RFC 6598 shared space) and fd7a:115c:a1e0::/48. */
export function isTailnetAddress(address: string | undefined): boolean {
  if (!address) return false;
  const v4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (isIP(v4) === 4) {
    const [first, second] = v4.split(".").map(Number);
    return first === 100 && second >= 64 && second <= 127;
  }
  return /^fd7a:115c:a1e0:/i.test(address);
}

const isLoopback = (address: string) => address === "127.0.0.1" || address === "::1" || address.startsWith("::ffff:127.");

/** The addresses this computer offers devices: the tailnet one only with Tailscale on, the rest only with Same Wi-Fi. */
export function routedAddresses(addresses: string[] = lanAddresses(), routes = current): string[] {
  return addresses.filter((address) => (isTailnetAddress(address) ? routes.tailscale : routes.wifi));
}

/** Security: the device port binds every interface, so a connection that arrived on a way in that is off is refused. */
export function acceptsLocalAddress(localAddress: string | undefined, routes = current): boolean {
  if (!localAddress) return false;
  if (isLoopback(localAddress)) return true;
  return isTailnetAddress(localAddress) ? routes.tailscale : routes.wifi;
}
