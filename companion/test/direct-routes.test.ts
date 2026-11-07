import { afterEach, describe, expect, it } from "vitest";

import { tailnetName } from "../src/listener.ts";
import { acceptsLocalAddress, directRoutesFromEnv, isTailnetAddress, routedAddresses, setDirectRoutes } from "../src/direct-routes.ts";

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

  it("tells tailnet addresses from the rest", () => {
    expect(isTailnetAddress("100.64.0.1")).toBe(true);
    expect(isTailnetAddress("::ffff:100.101.2.3")).toBe(true);
    expect(isTailnetAddress("fd7a:115c:a1e0::5")).toBe(true);
    expect(isTailnetAddress("100.128.0.1")).toBe(false);
    expect(isTailnetAddress("192.168.1.4")).toBe(false);
  });

  it("offers and answers on the tailnet only with Tailscale on, and on the LAN only with Same Wi-Fi on", () => {
    const addresses = ["192.168.1.4", "100.101.2.3"];
    setDirectRoutes({ wifi: true, tailscale: false });
    expect(routedAddresses(addresses)).toEqual(["192.168.1.4"]);
    expect(acceptsLocalAddress("100.101.2.3")).toBe(false);
    expect(acceptsLocalAddress("::ffff:192.168.1.4")).toBe(true);
    setDirectRoutes({ wifi: false, tailscale: true });
    expect(routedAddresses(addresses)).toEqual(["100.101.2.3"]);
    expect(acceptsLocalAddress("192.168.1.4")).toBe(false);
    expect(acceptsLocalAddress("100.101.2.3")).toBe(true);
    expect(acceptsLocalAddress("127.0.0.1")).toBe(true);
    expect(acceptsLocalAddress(undefined)).toBe(false);
  });
});
