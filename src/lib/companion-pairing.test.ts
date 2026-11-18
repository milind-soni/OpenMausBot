import { describe, expect, it } from "vitest";
import { phonePairingLink } from "../../shared/pairing-link";
import {
  companionPairingAddressText,
  companionPairingRoute,
  companionPairingRoutePin,
  companionPairingRoutePinAvailable,
} from "./companion-pairing";

describe("companionPairingRoute", () => {
  const token = `omb_pair_${"a".repeat(43)}`;

  const decodedEndpoints = (link: string) => {
    const encoded = new URL(link).searchParams.get("endpoints");
    if (!encoded) return null;
    const padded = encoded.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  };

  it("makes the automatic QR hosted-only even when Tailscale and LAN are advertised", () => {
    const endpoints = [
      { url: "https://device.openmausbot.com", kind: "hosted" as const, priority: 0 },
      { url: "http://mac.tail1234.ts.net:8810", kind: "tailnet" as const, priority: 100 },
      { url: "http://192.168.1.42:8810", kind: "lan" as const, priority: 200 },
    ];
    const route = companionPairingRoute({
      port: 8810,
      tailnetName: "mac.tail1234.ts.net",
      lan: "192.168.1.42",
      hosts: ["mac.tail1234.ts.net", "192.168.1.42"],
      endpoints,
    }, "automatic");

    expect(route).toEqual({
      address: "device.openmausbot.com",
      port: 443,
      hosts: ["device.openmausbot.com"],
      endpoints: [endpoints[0]],
    });
    const link = phonePairingLink({ ...route!, code: "004209", token });
    const url = new URL(link!);
    expect(url.searchParams.get("address")).toBe("device.openmausbot.com:443");
    expect(url.searchParams.get("hosts")).toBe("device.openmausbot.com");
    expect(url.searchParams.get("hosts")).not.toContain("192.168.1.42");
    expect(url.searchParams.get("hosts")).not.toContain("tail1234.ts.net");
    expect(decodedEndpoints(link!)).toEqual([endpoints[0]]);
    expect(companionPairingRoutePin({
      port: 8810,
      tailnetName: "mac.tail1234.ts.net",
      lan: "192.168.1.42",
      hosts: ["mac.tail1234.ts.net", "192.168.1.42"],
      endpoints,
    }, "automatic")?.protectedEndpoint?.kind).toBe("hosted");
  });

  it("refuses automatic pairing when hosted HTTPS is not ready", () => {
    const source = {
      port: 8810,
      tailnetName: "mac.tail1234.ts.net",
      lan: "192.168.1.42",
      hosts: ["mac.tail1234.ts.net", "192.168.1.42", "openmausbot-aa.local"],
      endpoints: [
        { url: "http://mac.tail1234.ts.net:8810", kind: "tailnet" as const, priority: 0 },
        { url: "http://192.168.1.42:8810", kind: "lan" as const, priority: 100 },
      ],
    };

    expect(companionPairingRoute(source, "automatic")).toBeNull();
    expect(companionPairingRoutePin(source, "automatic")).toBeNull();
  });

  it("pins the protected automatic transport instead of downgrading the live QR to LAN", () => {
    const opened = {
      port: 8810,
      lan: "192.168.1.42",
      hosts: ["192.168.1.42"],
      endpoints: [
        { url: "https://device.openmausbot.com", kind: "hosted" as const, priority: 0 },
        { url: "http://192.168.1.42:8810", kind: "lan" as const, priority: 200 },
      ],
    };
    const pin = companionPairingRoutePin(opened, "automatic");
    expect(pin?.protectedEndpoint).toEqual({
      url: "https://device.openmausbot.com",
      kind: "hosted",
      priority: 0,
    });
    expect(pin?.route).toMatchObject({
      address: "device.openmausbot.com",
      port: 443,
      hosts: ["device.openmausbot.com"],
    });

    const withdrawn = {
      ...opened,
      endpoints: [{ url: "http://192.168.1.42:8810", kind: "lan" as const, priority: 200 }],
    };
    expect(companionPairingRoute(withdrawn, "automatic")).toBeNull();
    expect(companionPairingRoutePinAvailable(withdrawn, pin!)).toBe(false);
    expect(pin?.route.endpoints?.map((endpoint) => endpoint.kind)).toEqual(["hosted"]);
  });

  it("does not substitute a different protected transport for the pinned one", () => {
    const opened = {
      port: 8810,
      tailnetName: "mac.tail1234.ts.net",
      endpoints: [
        { url: "https://device.openmausbot.com", kind: "hosted" as const, priority: 0 },
        { url: "http://mac.tail1234.ts.net:8810", kind: "tailnet" as const, priority: 100 },
      ],
    };
    const pin = companionPairingRoutePin(opened, "automatic");
    expect(pin?.protectedEndpoint?.kind).toBe("hosted");
    expect(companionPairingRoutePinAvailable({
      endpoints: [opened.endpoints[1]],
    }, pin!)).toBe(false);
  });

  it("selects hosted HTTPS regardless of an unprotected endpoint's priority", () => {
    expect(companionPairingRoutePin({
      port: 8810,
      lan: "192.168.1.42",
      endpoints: [
        { url: "http://192.168.1.42:8810", kind: "lan", priority: 0 },
        { url: "https://device.openmausbot.com", kind: "hosted", priority: 100 },
      ],
    }, "automatic")?.route).toEqual({
      address: "device.openmausbot.com",
      port: 443,
      hosts: ["device.openmausbot.com"],
      endpoints: [
        { url: "https://device.openmausbot.com", kind: "hosted", priority: 100 },
      ],
    });
  });

  it("makes the explicitly selected LAN route first without losing protected upgrades", () => {
    const route = companionPairingRoute({
      port: 8810,
      tailnetName: "mac.tail1234.ts.net",
      lan: "192.168.1.42",
      hosts: ["mac.tail1234.ts.net", "192.168.1.42", "openmausbot-aa.local"],
      endpoints: [
        { url: "https://device.openmausbot.com", kind: "hosted", priority: 0 },
        { url: "http://mac.tail1234.ts.net:8810", kind: "tailnet", priority: 100 },
        { url: "http://192.168.1.42:8810", kind: "lan", priority: 200 },
        { url: "http://openmausbot-aa.local:8810", kind: "bonjour", priority: 300 },
      ],
    }, "local");

    expect(route?.address).toBe("192.168.1.42");
    expect(route?.port).toBe(8810);
    expect(route?.hosts).toEqual([
      "192.168.1.42",
      "openmausbot-aa.local",
    ]);
    const link = phonePairingLink({ ...route!, code: "004209", token });
    expect(new URL(link!).searchParams.get("address")).toBe("192.168.1.42:8810");
    expect(decodedEndpoints(link!)).toEqual([
      { url: "http://192.168.1.42:8810", kind: "lan", priority: 0 },
      { url: "https://device.openmausbot.com", kind: "hosted", priority: 100 },
      { url: "http://openmausbot-aa.local:8810", kind: "bonjour", priority: 200 },
    ]);
  });

  it("keeps an explicitly selected Tailscale route off cleartext LAN fallbacks", () => {
    const route = companionPairingRoute({
      port: 8810,
      tailnetName: "mac.tail1234.ts.net",
      lan: "192.168.1.42",
      hosts: ["mac.tail1234.ts.net", "192.168.1.42", "openmausbot-aa.local"],
      endpoints: [
        { url: "https://device.openmausbot.com", kind: "hosted", priority: 0 },
        { url: "http://mac.tail1234.ts.net:8810", kind: "tailnet", priority: 100 },
        { url: "http://192.168.1.42:8810", kind: "lan", priority: 200 },
        { url: "http://openmausbot-aa.local:8810", kind: "bonjour", priority: 300 },
      ],
    }, "tailscale");

    expect(route).toMatchObject({
      address: "mac.tail1234.ts.net",
      port: 8810,
      hosts: ["mac.tail1234.ts.net"],
    });
    const link = phonePairingLink({ ...route!, code: "004209", token });
    expect(decodedEndpoints(link!)).toEqual([
      { url: "http://mac.tail1234.ts.net:8810", kind: "tailnet", priority: 0 },
      { url: "https://device.openmausbot.com", kind: "hosted", priority: 100 },
    ]);
    expect(new URL(link!).searchParams.get("hosts")).toBe("mac.tail1234.ts.net");
  });

  it("refuses a Tailscale label that is not a MagicDNS ts.net name", () => {
    expect(companionPairingRoute({
      port: 8810,
      tailnetName: "attacker.example",
      endpoints: [
        { url: "http://attacker.example:8810", kind: "tailnet", priority: 0 },
      ],
    }, "tailscale")).toBeNull();
  });

  it("uses the enabled Tailscale route name when the sidecar reports no tailnet endpoint or legacy name", () => {
    const source = {
      port: 8810,
      routes: { tailscale: { on: true, name: "mac.tail1234.ts.net" } },
      lan: "192.168.1.42",
      endpoints: [
        { url: "http://192.168.1.42:8810", kind: "lan" as const, priority: 200 },
      ],
    };
    const route = companionPairingRoute(source, "tailscale");
    expect(route?.address).toBe("mac.tail1234.ts.net");
    expect(route?.port).toBe(8810);
    expect(route?.hosts).toEqual(["mac.tail1234.ts.net"]);
    const pin = companionPairingRoutePin(source, "tailscale");
    expect(pin?.protectedEndpoint).toEqual({
      url: "http://mac.tail1234.ts.net:8810",
      kind: "tailnet",
      priority: 0,
    });
    expect(companionPairingRoutePinAvailable(source, pin!)).toBe(true);
  });

  it("prefers the saved Tailscale route name over a stale advertised endpoint", () => {
    const source = {
      port: 8810,
      tailnetName: "old.tail1234.ts.net",
      routes: { tailscale: { on: true, name: "new.tail1234.ts.net" } },
      endpoints: [
        { url: "http://old.tail1234.ts.net:8810", kind: "tailnet" as const, priority: 100 },
      ],
    };
    const route = companionPairingRoute(source, "tailscale");
    expect(route?.address).toBe("new.tail1234.ts.net");
    const pin = companionPairingRoutePin(source, "tailscale");
    expect(pin?.protectedEndpoint).toEqual({
      url: "http://new.tail1234.ts.net:8810",
      kind: "tailnet",
      priority: 0,
    });
    expect(companionPairingRoutePinAvailable(source, pin!)).toBe(true);
  });

  it("falls back to an advertised Tailscale endpoint when the saved name is not a MagicDNS name", () => {
    const source = {
      port: 8810,
      routes: { tailscale: { on: true, name: "attacker.example" } },
      endpoints: [
        { url: "http://mac.tail1234.ts.net:8810", kind: "tailnet" as const, priority: 100 },
      ],
    };
    expect(companionPairingRoute(source, "tailscale")?.address).toBe("mac.tail1234.ts.net");
  });

  it("ignores a Tailscale route name that is switched off", () => {
    expect(companionPairingRoute({
      port: 8810,
      routes: { tailscale: { on: false, name: "mac.tail1234.ts.net" } },
      endpoints: [],
    }, "tailscale")).toBeNull();
  });

  it("refuses an advertised Tailscale endpoint when the switch is off", () => {
    expect(companionPairingRoute({
      port: 8810,
      routes: { tailscale: { on: false, name: "mac.tail1234.ts.net" } },
      endpoints: [
        { url: "http://mac.tail1234.ts.net:8810", kind: "tailnet" as const, priority: 100 },
      ],
    }, "tailscale")).toBeNull();
  });

  it("refuses a legacy Tailscale name when the switch is off", () => {
    expect(companionPairingRoute({
      port: 8810,
      tailnetName: "mac.tail1234.ts.net",
      routes: { tailscale: { on: false, name: "mac.tail1234.ts.net" } },
      endpoints: [],
    }, "tailscale")).toBeNull();
  });

  it("ignores a non-MagicDNS name from the enabled Tailscale route", () => {
    expect(companionPairingRoute({
      port: 8810,
      routes: { tailscale: { on: true, name: "attacker.example" } },
      endpoints: [],
    }, "tailscale")).toBeNull();
  });

  it("does not keep a Tailscale pin when the enabled route name changes", () => {
    const source = {
      port: 8810,
      routes: { tailscale: { on: true, name: "mac.tail1234.ts.net" } },
      endpoints: [],
    };
    const pin = companionPairingRoutePin(source, "tailscale");
    expect(pin).not.toBeNull();
    expect(companionPairingRoutePinAvailable({
      ...source,
      routes: { tailscale: { on: true, name: "other.tail9999.ts.net" } },
    }, pin!)).toBe(false);
    expect(companionPairingRoutePinAvailable({
      ...source,
      routes: { tailscale: { on: false, name: "mac.tail1234.ts.net" } },
    }, pin!)).toBe(false);
    const staleEndpoint = {
      url: "http://mac.tail1234.ts.net:8810",
      kind: "tailnet" as const,
      priority: 100,
    };
    expect(companionPairingRoutePinAvailable({
      ...source,
      routes: { tailscale: { on: true, name: "other.tail9999.ts.net" } },
      endpoints: [staleEndpoint],
    }, pin!)).toBe(false);
    expect(companionPairingRoutePinAvailable({
      ...source,
      routes: { tailscale: { on: false, name: "mac.tail1234.ts.net" } },
      endpoints: [staleEndpoint],
    }, pin!)).toBe(false);
  });

  it("does not keep an advertised Tailscale pin when its endpoint is withdrawn", () => {
    const source = {
      port: 8810,
      routes: { tailscale: { on: true, name: "mac.tail1234.ts.net" } },
      endpoints: [
        { url: "http://mac.tail1234.ts.net:8810", kind: "tailnet" as const, priority: 100 },
      ],
    };
    const pin = companionPairingRoutePin(source, "tailscale");
    expect(pin?.protectedEndpointAdvertised).toBe(true);
    expect(companionPairingRoutePinAvailable(source, pin!)).toBe(true);
    expect(companionPairingRoutePinAvailable({ ...source, endpoints: [] }, pin!)).toBe(false);
  });

  it("keeps a Tailscale pin built from a legacy tailnetName when routes and endpoints are absent", () => {
    const source = { port: 8810, tailnetName: "mac.tail1234.ts.net" };
    const pin = companionPairingRoutePin(source, "tailscale");
    expect(pin).not.toBeNull();
    expect(pin?.protectedEndpointAdvertised).toBe(false);
    expect(companionPairingRoutePinAvailable(source, pin!)).toBe(true);
    expect(companionPairingRoutePinAvailable({ ...source, tailnetName: "other.tail9999.ts.net" }, pin!)).toBe(false);
  });

  it("refuses explicit local pairing when no LAN or Bonjour route exists", () => {
    expect(companionPairingRoute({
      port: 8810,
      tailnetName: "mac.tail1234.ts.net",
      hosts: ["mac.tail1234.ts.net"],
      endpoints: [
        { url: "https://device.openmausbot.com", kind: "hosted", priority: 0 },
        { url: "http://mac.tail1234.ts.net:8810", kind: "tailnet", priority: 100 },
      ],
    }, "local")).toBeNull();
  });

  it("uses an advertised Bonjour route when no LAN address is available", () => {
    const route = companionPairingRoute({
      port: 8810,
      hosts: ["mac.tail1234.ts.net", "openmausbot-aa.local"],
      discovery: { advertising: true, name: "openmausbot-aa.local" },
      endpoints: [
        { url: "https://device.openmausbot.com", kind: "hosted", priority: 0 },
        { url: "http://openmausbot-aa.local:8810", kind: "bonjour", priority: 300 },
      ],
    }, "local");

    expect(route?.address).toBe("openmausbot-aa.local");
    expect(route?.hosts?.[0]).toBe("openmausbot-aa.local");
    expect(route?.endpoints?.map((endpoint) => endpoint.kind)).toEqual(["bonjour", "hosted"]);
  });

  it("does not treat an inactive synthetic Bonjour name as a reachable local route", () => {
    expect(companionPairingRoute({
      port: 8810,
      hosts: ["mac.tail1234.ts.net", "openmausbot-aa.local"],
      discovery: { advertising: false, name: "openmausbot-aa.local" },
      endpoints: [
        { url: "https://device.openmausbot.com", kind: "hosted", priority: 0 },
        { url: "http://openmausbot-aa.local:8810", kind: "bonjour", priority: 300 },
      ],
    }, "local")).toBeNull();
  });
});

describe("companionPairingAddressText", () => {
  it("writes a hosted route with its scheme, so a phone does not send the code as HTTP to port 443", () => {
    const hosted = { url: "https://device.openmausbot.com", kind: "hosted" as const, priority: 0 };
    const route = companionPairingRoute({ port: 8810, endpoints: [hosted] }, "automatic");

    expect(companionPairingAddressText(route!)).toBe("https://device.openmausbot.com");
  });

  it("keeps a hosted route's non-default port", () => {
    expect(companionPairingAddressText({
      address: "box.example.com",
      port: 8443,
      endpoints: [{ url: "https://box.example.com:8443", kind: "hosted", priority: 0 }],
    })).toBe("https://box.example.com:8443");
  });

  it("leaves direct routes as host:port", () => {
    const route = companionPairingRoute({
      port: 8810,
      tailnetName: "mac.tail1234.ts.net",
      endpoints: [{ url: "http://mac.tail1234.ts.net:8810", kind: "tailnet", priority: 100 }],
    }, "tailscale");

    expect(companionPairingAddressText(route!)).toBe("mac.tail1234.ts.net:8810");
    expect(companionPairingAddressText({ address: "192.168.1.42", port: 8810 })).toBe("192.168.1.42:8810");
  });
});

