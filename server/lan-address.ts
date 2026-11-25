import type { Server } from "node:http";
import type { Socket } from "node:net";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

import { isPrivateHost } from "../shared/private-host.ts";

/** Bridges, VMs and VPN tunnels: their addresses reach this machine's containers or a VPN, not the person's devices. */
const HOST_ONLY_INTERFACE = /^(?:docker|br-|veth|virbr|vmnet|vboxnet|utun|tun|tap|wg|ppp|ipsec|bridge\d|vethernet)/i;
/** Tailscale's IPv6 prefix; 100.64/10 alone is shared with carrier NAT and other VPNs. */
const TAILSCALE_V6 = /^fd7a:115c:a1e0:/i;

const cgnat = (address: string) => {
  const [a, b] = address.split(".").map(Number);
  return a === 100 && b >= 64 && b <= 127;
};

export interface ReachableAddresses {
  /** IPv4 addresses on the local network, home and office ranges before carrier-NAT ones. */
  lan: string[];
  /** This machine's tailnet IPv4 addresses. */
  tailscale: string[];
}

/** Read afresh on every call, so a new Wi-Fi network or DHCP lease shows up in the next code's link. */
export function reachableAddresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): ReachableAddresses {
  const lan: string[] = [];
  const shared: string[] = [];
  const tailscale: string[] = [];
  for (const [name, entries = []] of Object.entries(interfaces)) {
    const v4 = entries.filter((entry) => entry.family === "IPv4" && !entry.internal).map((entry) => entry.address);
    if (/^tailscale/i.test(name) || entries.some((entry) => TAILSCALE_V6.test(entry.address))) {
      tailscale.push(...v4.filter(cgnat));
      continue;
    }
    if (HOST_ONLY_INTERFACE.test(name)) continue;
    for (const address of v4) {
      if (!isPrivateHost(address) || address.startsWith("127.") || address.startsWith("169.254.")) continue;
      (cgnat(address) ? shared : lan).push(address);
    }
  }
  return { lan: [...lan, ...shared], tailscale };
}

const plain = (address: string | undefined) => (address ?? "").replace(/^::ffff:/i, "");

/** Both ends of a connection on a network the person runs: a LAN listener answers nobody on the open internet. */
export function privateConnection(localAddress: string | undefined, remoteAddress: string | undefined): boolean {
  return isPrivateHost(plain(localAddress)) && isPrivateHost(plain(remoteAddress));
}

/** Where the server listens: loopback, or with OMB_LAN=1 every IPv4 address with each connection held to private ends,
 * so a new Wi-Fi network or DHCP lease needs no restart. */
export function listenHost(server: Server, env: NodeJS.ProcessEnv = process.env): string {
  if (env.OMB_LAN !== "1") return "127.0.0.1";
  server.on("connection", (socket: Socket) => {
    if (!privateConnection(socket.localAddress, socket.remoteAddress)) socket.destroy();
  });
  return "0.0.0.0";
}

/** With OMB_LAN=1, the address other devices on this network use, read afresh for each link; else null. */
export function lanUrl(port: number, env: NodeJS.ProcessEnv = process.env, addresses: () => ReachableAddresses = reachableAddresses): string | null {
  if (env.OMB_LAN !== "1") return null;
  const address = addresses().lan[0];
  return address ? `http://${address}:${port}` : null;
}
