// What a bot's browser may connect to: every address a destination resolves to gets a class, and the host
// OpenMausBot runs on decides which classes pass.
import { BlockList, isIP } from "node:net";
import { z } from "zod";

import { addressClass, listed, ownAddresses, type AddressClass } from "../../../electron/egress-addresses.mjs";

export { addressClass, ownAddresses, type AddressClass };

/** `desktop`: the app on someone's computer. `server`: self-hosted (Docker, npm). `cloud`: a MausBot Cloud home. */
export type EgressHost = "desktop" | "server" | "cloud";

/** `home-network` and `port` come from the person's own computer when My Cloud's browsing goes out through it. */
export type Refusal = "omb" | "this-computer" | "local-network" | "link-local" | "metadata" | "reserved" | "rebinding" | "reddit" | "home-network" | "port";

/** How a refusal reads in the page-health line. */
export const REFUSAL_TEXT: Record<Refusal, string> = {
  omb: "OpenMausBot's own service",
  "this-computer": "a service on this computer that no bot started",
  "local-network": "the local network",
  "link-local": "a link-local address",
  metadata: "the cloud metadata service",
  reserved: "a reserved address",
  rebinding: "a web address that points at this computer",
  reddit: "Reddit",
  "home-network": "the person's own computer or home network",
  port: "a port other than 80 and 443, which the person's computer does not open for bots",
};

const family = (address: string) => (isIP(address) === 6 ? "ipv6" : "ipv4");

/** Clash, Surge and other proxies in TUN + fake-IP mode answer every name from 198.18.0.0/15 and route it themselves. */
const FAKE_IP = new BlockList();
FAKE_IP.addSubnet("198.18.0.0", 15, "ipv4");

const SOCKS5_PROXY = /^socks5:\/\/(?:\[([0-9a-f:]+)\]|([A-Za-z0-9.-]+)):([0-9]{1,5})$/i;
export interface Socks5Proxy { host: string; port: number }
export function parseSocks5Proxy(value: string | undefined): Socks5Proxy | null {
  if (!value) return null;
  const match = SOCKS5_PROXY.exec(value.trim());
  const port = Number(match?.[3]);
  const host = match?.[1] ?? match?.[2];
  if (!match || !host || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  if (match[1] ? isIP(host) !== 6 : host.length > 253 || host.split(".").some((label) => label.length > 63 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(label))) return null;
  return { host, port };
}

/** An address literal, or a name RFC 6761 and Chrome resolve to loopback themselves. */
export function namesThisMachine(host: string): boolean {
  return isIP(host) !== 0 || /^(?:[^.]+\.)*localhost\.?$/i.test(host);
}

/** `browserEngine.egress` in config.json. */
export const browserEgressConfigSchema = z.object({
  /** Owner-configured unauthenticated SOCKS5 upstream for public destinations only. */
  proxy: z.string().trim().max(512).refine((value) => value === "" || parseSocks5Proxy(value) !== null, {
    message: "must be an unauthenticated socks5://host:port URL",
  }).optional(),
  /** Self-hosted servers only: local-network or this-computer destinations bots' browsers may reach, as
   * `10.0.0.5`, `192.168.1.0/24`, `10.0.0.5:8080`, `fd12::/48` or `[fd12::1]:443`. OpenMausBot's own ports,
   * cloud metadata and link-local addresses stay closed. MausBot Cloud ignores it. */
  allow: z.array(z.string().trim().max(64).refine((entry) => parseAllowEntry(entry) !== null, {
    message: "must be an IP address or CIDR range, with an optional :port",
  })).max(64).optional(),
  /** Desktop: false keeps bots' browsers off the local network (the default lets them reach it). Self-hosted
   * servers: true lets them open this server's own sites and its local network (off by default); OpenMausBot's
   * own ports, cloud metadata and link-local addresses stay closed. MausBot Cloud ignores it. */
  localNetwork: z.boolean().optional(),
});
export type BrowserEgressConfig = z.output<typeof browserEgressConfigSchema>;

interface AllowEntry { network: string; prefix: number; port: number | null }

export function parseAllowEntry(entry: string): AllowEntry | null {
  // A bare IPv6 address has colons of its own, so only its bracketed form takes a port.
  const match = /^\[([^\]]+)\](?:\/(\d{1,3}))?(?::(\d{1,5}))?$/.exec(entry)
    ?? (entry.split(":").length > 2 ? /^([^/]+)(?:\/(\d{1,3}))?()$/.exec(entry) : /^([^/:]+)(?:\/(\d{1,3}))?(?::(\d{1,5}))?$/.exec(entry));
  if (!match) return null;
  const [, network = "", prefixText, portText] = match;
  const kind = isIP(network);
  if (!kind) return null;
  const max = kind === 6 ? 128 : 32;
  const prefix = prefixText === undefined ? max : Number(prefixText);
  const port = portText ? Number(portText) : null;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return null;
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65_535)) return null;
  return { network, prefix, port };
}

export function allowList(entries: readonly string[] | undefined): (address: string, port: number) => boolean {
  const rules = (entries ?? []).flatMap((entry) => {
    const parsed = parseAllowEntry(entry);
    if (!parsed) return [];
    const list = new BlockList();
    list.addSubnet(parsed.network, parsed.prefix, family(parsed.network));
    return [{ list, port: parsed.port }];
  });
  return (raw, port) => {
    const address = raw.split("%", 1)[0]!;
    return rules.some((rule) => (rule.port === null || rule.port === port) && rule.list.check(address, family(address)));
  };
}

export interface EgressRules {
  host: EgressHost;
  /** A port one of OpenMausBot's own listeners holds on this machine. */
  ownPort(port: number): boolean;
  /** Whether every listener on this loopback port belongs to a bot's processes. */
  botPort(port: number): Promise<boolean>;
  /** Desktop: the person's local network. Self-hosted servers: this server's own sites and its local network. */
  localNetwork: boolean;
  /** Self-hosted servers: `browserEngine.egress.allow`. */
  allowed(address: string, port: number): boolean;
}

/**
 * Why a connection to `host:port`, resolved to `addresses`, is refused, or null when it may go ahead.
 * Every address must pass: the gate connects only to addresses checked here.
 */
export async function refusalFor(
  target: { host: string; port: number },
  addresses: readonly { address: string }[],
  rules: EgressRules,
  own: BlockList = ownAddresses(),
): Promise<Refusal | null> {
  const { host, port } = target;
  for (const { address } of addresses) {
    let kind = addressClass(address, own);
    // On the desktop these come from the person's own proxy: the local network, unless this computer holds the address.
    if (kind === "reserved" && rules.host === "desktop" && listed(FAKE_IP, address)) {
      // The proxy picks the real destination, which may be this computer: never let it reach OpenMausBot's own ports.
      if (rules.ownPort(port)) return "omb";
      kind = listed(own, address) ? "this-machine" : "private";
    }
    if (kind === "public") continue;
    if (kind === "metadata" || kind === "link-local" || kind === "reserved") return kind;
    if (kind === "private") {
      if (rules.host === "desktop" ? rules.localNetwork : rules.host === "server" && rules.allowed(address, port)) continue;
      // The owner's switch opens the local network, but never OpenMausBot's own ports through it (a Docker host's gateway).
      if (rules.host === "server" && rules.localNetwork) {
        if (rules.ownPort(port)) return "omb";
        continue;
      }
      return "local-network";
    }
    if (rules.ownPort(port)) return "omb";
    // Desktop dev servers are reached by name or address, never through a public name that points here.
    if (rules.host === "desktop") {
      if (namesThisMachine(host)) continue;
      return "rebinding";
    }
    // The owner's switch opens this server's own sites, but a public name pointing at loopback (DNS rebinding) stays
    // shut: loopback-only services are reached by localhost or an address.
    if (rules.host === "server" && rules.localNetwork && (kind === "this-machine" || namesThisMachine(host))) continue;
    if (rules.host === "server" && rules.allowed(address, port)) continue;
    if (await rules.botPort(port)) continue;
    return "this-computer";
  }
  return null;
}
