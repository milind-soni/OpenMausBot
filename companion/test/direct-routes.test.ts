import { afterEach, describe, expect, it } from "vitest";

import { tailnetName } from "../src/listener.ts";
import { acceptsConnection, directRoutesFromEnv, isPrivateLanAddress, isTailnetAddress, routedAddresses, setDirectRoutes, tailnetInterfaceAddresses } from "../src/direct-routes.ts";

const iface = (address: string, family: "IPv4" | "IPv6" = "IPv4") => ({ address, family, internal: false, netmask: "", mac: "", cidr: null }) as never;
const macTailnet = tailnetInterfaceAddresses({ en0: [iface("192.168.1.4")], utun4: [iface("100.101.2.3"), iface("fd7a:115c:a1e0::5", "IPv6")] });

afterEach(() => {
  setDirectRoutes({ wifi: true, tailscale: false, tailnetName: null });
});

describe("direct ways in", () => {
  it("serves Same Wi-Fi alone when standing alone, and exactly what the desktop app lists otherwise", () => {
    expect(directRoutesFromEnv({})).toEqual({ wifi: true, tailscale: false, tailnetName: null });
    expect(directRoutesFromEnv({ OMB_COMPANION_ROUTES: "" })).toEqual({ wifi: false, tailscale: false, tailnetName: null });
    expect(directRoutesFromEnv({ OMB_COMPANION_ROUTES: "tailscale", OMB_COMPANION_TAILNET_NAME: "Mac.tail1.ts.net" }))
      .toEqual({ wifi: false, tailscale: true, tailnetName: "mac.tail1.ts.net" });
    expect(tailnetName()).toBe("mac.tail1.ts.net");
  });

  it("forgets the tailnet name while Tailscale is off, and refuses a name that isn't a tailnet one", () => {
    setDirectRoutes({ wifi: true, tailscale: false, tailnetName: "mac.tail1.ts.net" });
    expect(tailnetName()).toBeNull();
    expect(setDirectRoutes({ tailscale: true, tailnetName: "evil.example.com" }).tailnetName).toBe("mac.tail1.ts.net");
  });

  it("finds the tailnet by Tailscale's interface, never by a 100.64/10 address alone", () => {
    expect(isTailnetAddress("100.101.2.3", macTailnet)).toBe(true);
    expect(isTailnetAddress("::ffff:100.101.2.3", macTailnet)).toBe(true);
    expect(isTailnetAddress("192.168.1.4", macTailnet)).toBe(false);
    expect(isTailnetAddress("100.80.0.9", tailnetInterfaceAddresses({ en0: [iface("100.80.0.9")] }))).toBe(false);
    expect(isTailnetAddress("100.80.0.9", tailnetInterfaceAddresses({ utun2: [iface("100.80.0.9")] }))).toBe(false);
    expect(isTailnetAddress("100.70.0.1", tailnetInterfaceAddresses({ tailscale0: [iface("100.70.0.1")] }))).toBe(true);
    expect(isTailnetAddress("100.70.0.1", tailnetInterfaceAddresses({ Tailscale: [iface("100.70.0.1")] }))).toBe(true);
  });

  it("calls only loopback, RFC 1918, link-local and fd00::/8 private", () => {
    for (const address of ["127.0.0.1", "10.0.0.2", "172.20.1.1", "192.168.1.4", "169.254.3.3", "fe80::1", "fd12::3", "::ffff:192.168.1.4"]) expect(isPrivateLanAddress(address)).toBe(true);
    for (const address of ["203.0.113.9", "100.80.0.9", "172.32.0.1", "8.8.8.8", "2001:db8::1"]) expect(isPrivateLanAddress(address)).toBe(false);
  });

  it("answers a connection only when both ends are private and its way in is on", () => {
    setDirectRoutes({ wifi: true, tailscale: false });
    expect(acceptsConnection("192.168.1.4", "192.168.1.20", undefined, macTailnet)).toBe(true);
    expect(acceptsConnection("192.168.1.4", "203.0.113.9", undefined, macTailnet)).toBe(false);
    expect(acceptsConnection("203.0.113.5", "198.51.100.7", undefined, macTailnet)).toBe(false);
    expect(acceptsConnection("100.101.2.3", "100.64.0.8", undefined, macTailnet)).toBe(false);
    setDirectRoutes({ wifi: false, tailscale: true });
    expect(acceptsConnection("100.101.2.3", "100.64.0.8", undefined, macTailnet)).toBe(true);
    expect(acceptsConnection("100.101.2.3", "203.0.113.9", undefined, macTailnet)).toBe(false);
    expect(acceptsConnection("192.168.1.4", "192.168.1.20", undefined, macTailnet)).toBe(false);
    expect(acceptsConnection("127.0.0.1", "127.0.0.1", undefined, macTailnet)).toBe(true);
    expect(acceptsConnection("127.0.0.1", "203.0.113.9", undefined, macTailnet)).toBe(false);
    expect(acceptsConnection(undefined, "192.168.1.20", undefined, macTailnet)).toBe(false);
  });

  it("offers the tailnet address only with Tailscale on, and private LAN addresses only with Same Wi-Fi on", () => {
    const addresses = ["192.168.1.4", "100.101.2.3", "203.0.113.5"];
    expect(routedAddresses(addresses, { wifi: true, tailscale: false, tailnetName: null }, macTailnet)).toEqual(["192.168.1.4"]);
    expect(routedAddresses(addresses, { wifi: false, tailscale: true, tailnetName: null }, macTailnet)).toEqual(["100.101.2.3"]);
  });
});
