// A lent computer's own check on every connection My Cloud's browsers make through it: web ports on the public
// internet only. Never this computer, the devices on its networks, its home's own public address, link-local, a cloud
// metadata service or a reserved range; it looks names up itself and connects only to the addresses it checked.
import { lookup } from "node:dns/promises";
import { BlockList, connect as tcpConnect, isIP } from "node:net";
import { networkInterfaces } from "node:os";

import { addressClass, listed, ownAddresses, ownSubnets } from "./egress-addresses.mjs";

export const DEVICE_PORTS = Object.freeze([80, 443]);
const CONNECT_MS = 10_000;
const LOCAL_NAME = /^(?:[^.]+\.)*localhost\.?$/i;

/** The addresses that are this computer's home: its networks and the public address My Cloud sees it connect from. */
export function homeAddresses(interfaces, seenAs) {
  const home = ownSubnets(interfaces);
  if (typeof seenAs === "string" && isIP(seenAs)) home.addAddress(seenAs, isIP(seenAs) === 6 ? "ipv6" : "ipv4");
  return home;
}

/** Why this computer will not connect to `port` on these addresses, or null. Every address must pass. */
export function deviceRefusal(port, addresses, { own = new BlockList(), home = new BlockList() } = {}) {
  if (!DEVICE_PORTS.includes(port)) return "port";
  for (const raw of addresses) {
    const kind = addressClass(raw, own);
    if (kind === "metadata" || kind === "link-local" || kind === "reserved") return kind;
    if (kind !== "public" || listed(home, raw)) return "home-network";
  }
  return null;
}

const resolveName = (host) => lookup(host, { all: true, verbatim: true }).catch(() => []);

/**
 * `open({ host, port })` answers `{ socket }` once connected, `{ refused }` with the reason, or `{ failed }`
 * ("unreachable", "refused", "timeout"). `seenAs()`: the address My Cloud last saw this computer connect from.
 */
export function createDeviceEgress({ resolve = resolveName, connect = tcpConnect, interfaces = networkInterfaces, seenAs = () => null, connectMs = CONNECT_MS } = {}) {
  return {
    async open({ host, port }) {
      if (typeof host !== "string" || !host || host.length > 255 || !Number.isInteger(port)) return { refused: "reserved" };
      if (!DEVICE_PORTS.includes(port)) return { refused: "port" };
      if (LOCAL_NAME.test(host)) return { refused: "home-network" };
      const literal = isIP(host);
      const addresses = literal ? [{ address: host, family: literal }] : await resolve(host);
      const now = interfaces();
      const refusal = deviceRefusal(port, addresses.map((entry) => entry.address), { own: ownAddresses(now), home: homeAddresses(now, seenAs()) });
      if (refusal) return { refused: refusal };
      if (!addresses.length) return { failed: "unreachable" };
      return new Promise((settle) => {
        // Every checked address, either family, so a host is still reached where one family is broken; the lookup hands
        // back only checked addresses, so a name that now resolves elsewhere changes nothing.
        const socket = connect({
          host, port, autoSelectFamily: true,
          lookup: (_name, options, callback) => options.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family),
        });
        const done = (result) => { clearTimeout(timer); socket.off("connect", opened); socket.off("error", failed); settle(result); };
        const opened = () => done({ socket });
        const failed = (error) => { socket.destroy(); done({ failed: error?.code === "ECONNREFUSED" ? "refused" : "unreachable" }); };
        const timer = setTimeout(() => { socket.destroy(); done({ failed: "timeout" }); }, connectMs);
        socket.once("connect", opened);
        socket.once("error", failed);
      });
    },
  };
}
