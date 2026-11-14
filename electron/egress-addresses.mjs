// Which kind of address a browser connection would reach: the one list My Cloud's egress gate and a lent computer's
// own check both use.
//
// The address ranges, the NAT64 and 6to4 unwrapping and this machine's own addresses are adapted from
// pingdotgg/t3code@00cdceb1 apps/server/src/htmlRender/publicProxy.ts, MIT License, Copyright (c) 2026
// T3 Tools Inc. (full text in third_party/t3-code/LICENSE); modified: an address gets a class instead of
// local-or-public, cloud metadata addresses are a class of their own, and a machine's own networks are a list too.
import { BlockList, isIP } from "node:net";
import { networkInterfaces } from "node:os";

const family = (address) => (isIP(address) === 6 ? "ipv6" : "ipv4");

function subnets(entries) {
  const list = new BlockList();
  for (const [network, prefix] of entries) list.addSubnet(network, prefix, family(network));
  return list;
}

const LOOPBACK = subnets([["127.0.0.0", 8], ["::1", 128]]);
// ::/96 (IPv4-compatible, which also holds the unspecified address), local-use NAT64 and Teredo carry an
// IPv4 address a translator may route to without checking it.
const RESERVED = subnets([
  ["0.0.0.0", 8], ["198.18.0.0", 15], ["224.0.0.0", 3],
  ["::", 96], ["64:ff9b:1::", 48], ["2001::", 32], ["ff00::", 8],
]);
const LINK_LOCAL = subnets([["169.254.0.0", 16], ["fe80::", 10]]);
// fc00::/7 holds Fly's private 6PN network (fdaa::/16), which links a Cloud home to other customers' machines.
const PRIVATE = subnets([["10.0.0.0", 8], ["100.64.0.0", 10], ["172.16.0.0", 12], ["192.168.0.0", 16], ["fc00::", 7]]);
// AWS (IPv4 and IPv6), Azure, GCP and Oracle answer on 169.254.169.254; Alibaba on 100.100.100.200.
const METADATA = new BlockList();
for (const address of ["169.254.169.254", "fd00:ec2::254", "100.100.100.200"]) METADATA.addAddress(address, family(address));

const NAT64 = subnets([["64:ff9b::", 96]]);
const SIX_TO_FOUR = subnets([["2002::", 16]]);

/** The sixteen-bit groups of an IPv6 address, which may end in dotted IPv4. */
function ipv6Groups(address) {
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address);
  const text = dotted
    ? `${address.slice(0, dotted.index)}${((+dotted[1] << 8) | +dotted[2]).toString(16)}:${((+dotted[3] << 8) | +dotted[4]).toString(16)}`
    : address;
  const [head = "", tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array(fill).fill("0"), ...right].map((group) => Number.parseInt(group, 16));
}

/** The IPv4 address a NAT64 or 6to4 address stands for, which a translator will route to. */
function embeddedIPv4(address) {
  const at = NAT64.check(address, "ipv6") ? 6 : SIX_TO_FOUR.check(address, "ipv6") ? 1 : -1;
  if (at === -1) return undefined;
  const groups = ipv6Groups(address);
  const high = groups[at] ?? 0;
  const low = groups[at + 1] ?? 0;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

/** The addresses this machine's interfaces hold right now; IPv4-mapped IPv6 matches their IPv4 entries. */
export function ownAddresses(interfaces = networkInterfaces()) {
  const own = new BlockList();
  for (const entry of Object.values(interfaces).flat()) {
    if (entry) own.addAddress(entry.address.split("%", 1)[0], entry.family === "IPv6" ? "ipv6" : "ipv4");
  }
  return own;
}

/** Shorter prefixes are a VPN's catch-all route, not a network of devices beside this one. */
const NARROWEST_LOCAL = { ipv4: 8, ipv6: 16 };

/** The networks this machine's interfaces sit on: a public IPv6 prefix at home reaches the other devices there. */
export function ownSubnets(interfaces = networkInterfaces()) {
  const list = new BlockList();
  for (const entry of Object.values(interfaces).flat()) {
    const [network, bits] = String(entry?.cidr ?? "").split("/");
    const type = entry?.family === "IPv6" ? "ipv6" : "ipv4";
    const prefix = Number(bits);
    if (!network || !isIP(network.split("%", 1)[0]) || !Number.isInteger(prefix) || prefix < NARROWEST_LOCAL[type]) continue;
    list.addSubnet(network.split("%", 1)[0], prefix, type);
  }
  return list;
}

export function addressClass(raw, own = ownAddresses()) {
  const address = raw.split("%", 1)[0];
  if (!isIP(address)) return "reserved";
  const type = family(address);
  const embedded = type === "ipv6" ? embeddedIPv4(address) : undefined;
  if (embedded !== undefined) return addressClass(embedded, own);
  if (METADATA.check(address, type)) return "metadata";
  if (LOOPBACK.check(address, type)) return "loopback";
  if (RESERVED.check(address, type)) return "reserved";
  if (LINK_LOCAL.check(address, type)) return "link-local";
  if (own.check(address, type)) return "this-machine";
  if (PRIVATE.check(address, type)) return "private";
  return "public";
}

/** Whether `address` is in `list`, an address of either family; IPv4-mapped IPv6 matches IPv4 entries. */
export function listed(list, raw) {
  const address = raw.split("%", 1)[0];
  return isIP(address) !== 0 && list.check(address, family(address));
}
