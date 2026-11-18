// Whether an MCP server's address is out on the public internet. Below Full access a bot may turn on such a server
// itself, since it only connects to an address anyone could reach; one on the person's own computer or network (loopback,
// a LAN address, a local name) stays behind the person's yes. Anything unclear counts as not public, so it keeps the card.
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

import { isPublicDomainAddress } from "./custom-domain.ts";

/** Every address a host name resolves to. */
export type HostLookup = (host: string) => Promise<ReadonlyArray<{ address: string }>>;

const LOCAL_NAME = /(?:^|\.)(?:localhost|local|internal|lan|home\.arpa|ts\.net)$/;
const lookupAll: HostLookup = (host) => dnsLookup(host, { all: true, verbatim: true });

export async function publicMcpUrl(raw: string, lookup: HostLookup = lookupAll): Promise<boolean> {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!host || LOCAL_NAME.test(host)) return false;
  if (isIP(host)) return isPublicDomainAddress(host);
  try {
    const addresses = await lookup(host);
    return addresses.length > 0 && addresses.every((entry) => isPublicDomainAddress(entry.address));
  } catch {
    return false;
  }
}
