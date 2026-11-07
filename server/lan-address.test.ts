import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, it } from "vitest";

import { lanUrl, listenHost, privateConnection, reachableAddresses } from "./lan-address.ts";

const v4 = (address: string, internal = false) => ({ address, family: "IPv4", internal, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: null }) as NetworkInterfaceInfo;
const v6 = (address: string) => ({ address, family: "IPv6", internal: false, netmask: "ffff::", mac: "00:00:00:00:00:00", cidr: null, scopeid: 0 }) as NetworkInterfaceInfo;

it("links to the LAN address, never a container bridge or a VPN tunnel", () => {
  expect(reachableAddresses({
    lo: [v4("127.0.0.1", true)],
    docker0: [v4("172.17.0.1")],
    "br-5a1c": [v4("172.18.0.1")],
    veth12ab: [v4("169.254.3.3")],
    wg0: [v4("10.77.11.209")],
    virbr0: [v4("192.168.122.1")],
    vmnet8: [v4("172.16.44.1")],
    eth0: [v4("203.0.113.9")],
    en0: [v4("192.168.1.20"), v6("fe80::1")],
  })).toEqual({ lan: ["192.168.1.20"], tailscale: [] });
});

it("counts 100.64/10 as Tailscale only on Tailscale's interface, and prefers the LAN over carrier NAT", () => {
  expect(reachableAddresses({
    CloudflareWARP: [v4("100.96.0.5")],
    tailscale0: [v4("100.101.102.103")],
    utun4: [v4("100.88.1.2"), v6("fd7a:115c:a1e0::1")],
    utun5: [v4("100.70.0.9")],
    en0: [v4("10.0.0.7")],
  })).toEqual({ lan: ["10.0.0.7", "100.96.0.5"], tailscale: ["100.101.102.103", "100.88.1.2"] });
});

it("a VPS with only a public address has no LAN address", () => {
  expect(reachableAddresses({ eth0: [v4("198.51.100.4")], docker0: [v4("172.17.0.1")] })).toEqual({ lan: [], tailscale: [] });
});

describe("the LAN listener", () => {
  it("answers only when both ends of a connection are private", () => {
    expect(privateConnection("192.168.1.20", "192.168.1.50")).toBe(true);
    expect(privateConnection("::ffff:10.0.0.2", "::ffff:10.0.0.9")).toBe(true);
    expect(privateConnection("100.101.102.103", "100.64.0.7")).toBe(true);
    expect(privateConnection("192.168.1.20", "203.0.113.9")).toBe(false);
    expect(privateConnection("198.51.100.4", "10.0.0.9")).toBe(false);
    expect(privateConnection(undefined, "10.0.0.9")).toBe(false);
  });

  it("listens on loopback unless OMB_LAN=1, then drops every connection with a public end", () => {
    const loopback = new EventEmitter() as unknown as Server;
    expect(listenHost(loopback, {})).toBe("127.0.0.1");
    expect((loopback as unknown as EventEmitter).listenerCount("connection")).toBe(0);
    const lan = new EventEmitter();
    expect(listenHost(lan as unknown as Server, { OMB_LAN: "1" })).toBe("0.0.0.0");
    const socket = (localAddress: string, remoteAddress: string) => ({ localAddress, remoteAddress, destroyed: false, destroy() { this.destroyed = true; } });
    const stranger = socket("192.168.1.20", "203.0.113.9");
    const neighbour = socket("192.168.1.20", "192.168.1.50");
    lan.emit("connection", stranger);
    lan.emit("connection", neighbour);
    expect([stranger.destroyed, neighbour.destroyed]).toEqual([true, false]);
  });

  it("links to this network's address with OMB_LAN=1 only", () => {
    const addresses = () => ({ lan: ["192.168.1.20", "100.70.0.1"], tailscale: [] });
    expect(lanUrl(8799, { OMB_LAN: "1" }, addresses)).toBe("http://192.168.1.20:8799");
    expect(lanUrl(8799, {}, addresses)).toBeNull();
    expect(lanUrl(8799, { OMB_LAN: "1" }, () => ({ lan: [], tailscale: [] }))).toBeNull();
  });
});
