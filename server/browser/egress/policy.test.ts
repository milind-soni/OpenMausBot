import { BlockList } from "node:net";
import { describe, expect, it } from "vitest";

import { addressClass, allowList, browserEgressConfigSchema, namesThisMachine, parseAllowEntry, refusalFor, type EgressHost, type EgressRules } from "./policy.ts";

// A public address this machine holds, and its LAN address.
const own = new BlockList();
own.addAddress("198.51.100.7", "ipv4");
own.addAddress("192.168.1.5", "ipv4");
// The address a fake-IP proxy (Clash, Surge) gives its own TUN interface.
own.addAddress("198.18.0.1", "ipv4");

const rules = (host: EgressHost, over: Partial<EgressRules> = {}): EgressRules => ({
  host,
  ownPort: (port) => port === 8799,
  botPort: async (port) => port === 3000,
  localNetwork: true,
  allowed: () => false,
  ...over,
});

const decide = (host: EgressHost, target: string, addresses: string[], over: Partial<EgressRules> = {}) => {
  const [name, port] = target.split(/:(?=\d+$)/);
  return refusalFor({ host: name!, port: Number(port) }, addresses.map((address) => ({ address })), rules(host, over), own);
};

describe("address classes", () => {
  it.each([
    ["93.184.215.14", "public"],
    ["2606:2800:21f:cb07:6820:80da:af6b:8b2c", "public"],
    ["127.0.0.1", "loopback"],
    ["127.5.6.7", "loopback"],
    ["::1", "loopback"],
    ["::ffff:7f00:1", "loopback"],
    ["::ffff:127.0.0.1", "loopback"],
    ["0.0.0.0", "reserved"],
    ["::", "reserved"],
    ["::7f00:1", "reserved"],
    ["198.18.0.1", "reserved"],
    ["224.0.0.251", "reserved"],
    ["255.255.255.255", "reserved"],
    ["ff02::1", "reserved"],
    ["2001::1", "reserved"],
    ["64:ff9b:1::1", "reserved"],
    ["169.254.169.254", "metadata"],
    ["fd00:ec2::254", "metadata"],
    ["100.100.100.200", "metadata"],
    ["169.254.1.1", "link-local"],
    ["fe80::1", "link-local"],
    ["fe80::1%en0", "link-local"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["192.168.0.1", "private"],
    ["100.64.0.7", "private"],
    ["fd12:3456::1", "private"],
    ["fdaa::1", "private"],
    ["::ffff:10.0.0.1", "private"],
    ["198.51.100.7", "this-machine"],
    ["::ffff:c633:6407", "this-machine"],
    ["192.168.1.5", "this-machine"],
    // NAT64 and 6to4 stand for the IPv4 address they carry; a public one stays public.
    ["64:ff9b::7f00:1", "loopback"],
    ["64:ff9b::a00:1", "private"],
    ["64:ff9b::5db8:d70e", "public"],
    ["2002:7f00:1::1", "loopback"],
    ["2002:a9fe:a9fe::1", "metadata"],
    ["not an address", "reserved"],
  ])("%s is %s", (address, expected) => {
    expect(addressClass(address, own)).toBe(expected);
  });
});

describe("what each host lets a bot's browser reach", () => {
  it("lets every host reach the public internet", async () => {
    for (const host of ["desktop", "server", "cloud"] as const) {
      expect(await decide(host, "example.com:443", ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"])).toBeNull();
    }
  });

  it("never reaches OpenMausBot's own ports, on loopback or on this machine's own addresses", async () => {
    for (const host of ["desktop", "server", "cloud"] as const) {
      for (const [target, address] of [["127.0.0.1:8799", "127.0.0.1"], ["localhost:8799", "::1"], ["::ffff:7f00:1:8799", "::ffff:7f00:1"], ["192.168.1.5:8799", "192.168.1.5"], ["198.51.100.7:8799", "198.51.100.7"]]) {
        expect(await decide(host, target!, [address!], { allowed: () => true, botPort: async () => true }), `${host} ${target}`).toBe("omb");
      }
    }
  });

  it("never reaches cloud metadata, link-local or reserved addresses, whatever the allow-list says", async () => {
    for (const host of ["desktop", "server", "cloud"] as const) {
      const open = { allowed: () => true, localNetwork: true };
      expect(await decide(host, "169.254.169.254:80", ["169.254.169.254"], open)).toBe("metadata");
      expect(await decide(host, "metadata.google.internal:80", ["169.254.169.254"], open)).toBe("metadata");
      expect(await decide(host, "fd00:ec2::254:80", ["fd00:ec2::254"], open)).toBe("metadata");
      expect(await decide(host, "100.100.100.200:80", ["100.100.100.200"], open)).toBe("metadata");
      expect(await decide(host, "printer:631", ["169.254.7.7"], open)).toBe("link-local");
      expect(await decide(host, "0.0.0.0:8080", ["0.0.0.0"], open)).toBe("reserved");
      expect(await decide(host, "224.0.0.1:80", ["224.0.0.1"], open)).toBe("reserved");
    }
  });

  it("lets the desktop reach dev servers on this machine by name or address, never through a public name", async () => {
    expect(await decide("desktop", "localhost:5173", ["127.0.0.1", "::1"])).toBeNull();
    expect(await decide("desktop", "app.localhost:5173", ["127.0.0.1"])).toBeNull();
    expect(await decide("desktop", "127.0.0.1:3000", ["127.0.0.1"])).toBeNull();
    expect(await decide("desktop", "192.168.1.5:3000", ["192.168.1.5"])).toBeNull();
    expect(await decide("desktop", "rebind.example:3000", ["127.0.0.1"])).toBe("rebinding");
    expect(await decide("desktop", "rebind.example:3000", ["93.184.215.14", "127.0.0.1"])).toBe("rebinding");
  });

  it("lets the desktop reach the local network unless the person turned it off", async () => {
    expect(await decide("desktop", "nas.local:443", ["192.168.1.20"])).toBeNull();
    expect(await decide("desktop", "[fd12::5]:443", ["fd12::5"])).toBeNull();
    expect(await decide("desktop", "nas.local:443", ["192.168.1.20"], { localNetwork: false })).toBe("local-network");
  });

  it("lets the desktop reach a proxy's fake-IP answers (198.18.0.0/15) like the local network; servers and Cloud keep refusing them", async () => {
    // Clash, Surge and similar proxies in TUN + fake-IP mode answer every name with an address in 198.18.0.0/15.
    expect(await decide("desktop", "example.com:443", ["198.18.0.7"])).toBeNull();
    expect(await decide("desktop", "github.com:443", ["198.19.255.254", "::ffff:198.18.1.2"])).toBeNull();
    expect(await decide("desktop", "example.com:443", ["198.18.0.7"], { localNetwork: false })).toBe("local-network");
    // The proxy's own interface is this computer: only a name for this machine reaches it, never a public one.
    expect(await decide("desktop", "example.com:443", ["198.18.0.1"])).toBe("rebinding");
    expect(await decide("desktop", "198.18.0.1:8080", ["198.18.0.1"])).toBeNull();
    for (const host of ["server", "cloud"] as const) {
      expect(await decide(host, "example.com:443", ["198.18.0.7"], { allowed: () => true }), host).toBe("reserved");
    }
  });

  it("lets a server reach only the loopback ports a bot's own processes opened, or that an admin allowed", async () => {
    expect(await decide("server", "localhost:3000", ["127.0.0.1"])).toBeNull();
    expect(await decide("server", "localhost:3001", ["127.0.0.1"])).toBe("this-computer");
    expect(await decide("server", "127.0.0.1:9000", ["127.0.0.1"], { allowed: (address, port) => address === "127.0.0.1" && port === 9000 })).toBeNull();
    expect(await decide("cloud", "localhost:3000", ["127.0.0.1"])).toBeNull();
    expect(await decide("cloud", "localhost:9000", ["127.0.0.1"], { allowed: () => true })).toBe("this-computer");
  });

  it("keeps a server off the local network unless an admin allowed it, and Cloud off it always", async () => {
    expect(await decide("server", "nas:443", ["10.0.0.20"])).toBe("local-network");
    expect(await decide("server", "nas:443", ["10.0.0.20"], { allowed: (address) => address === "10.0.0.20" })).toBeNull();
    for (const address of ["10.0.0.20", "172.20.0.2", "192.168.0.10", "100.64.1.1", "fdaa:0:1::3", "fd12::1"]) {
      expect(await decide("cloud", `peer:443`, [address], { allowed: () => true, localNetwork: true }), address).toBe("local-network");
    }
  });

  it("refuses when any address a name resolves to is refused", async () => {
    expect(await decide("cloud", "mixed.example:443", ["93.184.215.14", "10.0.0.1"])).toBe("local-network");
  });
});

describe("browserEngine.egress.allow", () => {
  it("parses addresses and ranges with an optional port", () => {
    expect(parseAllowEntry("10.0.0.5")).toEqual({ network: "10.0.0.5", prefix: 32, port: null });
    expect(parseAllowEntry("192.168.1.0/24")).toEqual({ network: "192.168.1.0", prefix: 24, port: null });
    expect(parseAllowEntry("10.0.0.5:8080")).toEqual({ network: "10.0.0.5", prefix: 32, port: 8080 });
    expect(parseAllowEntry("10.0.0.0/8:443")).toEqual({ network: "10.0.0.0", prefix: 8, port: 443 });
    expect(parseAllowEntry("fd12::1")).toEqual({ network: "fd12::1", prefix: 128, port: null });
    expect(parseAllowEntry("fd12::/48")).toEqual({ network: "fd12::", prefix: 48, port: null });
    expect(parseAllowEntry("[fd12::1]:443")).toEqual({ network: "fd12::1", prefix: 128, port: 443 });
    expect(parseAllowEntry("[fd12::]/48:443")).toEqual({ network: "fd12::", prefix: 48, port: 443 });
    for (const bad of ["nas.local", "10.0.0.5:0", "10.0.0.5:70000", "10.0.0.0/33", "fd12::/129", "", "10.0.0.5:", "[fd12::1]"+"x"]) {
      expect(parseAllowEntry(bad), bad).toBeNull();
    }
  });

  it("matches only the listed addresses and ports", () => {
    const allowed = allowList(["192.168.1.0/24", "10.0.0.5:8080", "[fd12::1]:443"]);
    expect(allowed("192.168.1.77", 80)).toBe(true);
    expect(allowed("::ffff:192.168.1.77", 80)).toBe(true);
    expect(allowed("192.168.2.1", 80)).toBe(false);
    expect(allowed("10.0.0.5", 8080)).toBe(true);
    expect(allowed("10.0.0.5", 8081)).toBe(false);
    expect(allowed("fd12::1", 443)).toBe(true);
    expect(allowed("fd12::1", 80)).toBe(false);
    expect(allowList(undefined)("10.0.0.5", 80)).toBe(false);
  });

  it("refuses a config entry it cannot read", () => {
    expect(browserEgressConfigSchema.safeParse({ allow: ["10.0.0.0/8"], localNetwork: false }).success).toBe(true);
    expect(browserEgressConfigSchema.safeParse({ allow: ["nas.local"] }).success).toBe(false);
  });
});

describe("names that mean this machine", () => {
  it("are address literals and localhost names", () => {
    for (const host of ["127.0.0.1", "::1", "10.0.0.5", "localhost", "LOCALHOST", "localhost.", "app.localhost", "a.b.localhost."]) expect(namesThisMachine(host), host).toBe(true);
    for (const host of ["example.com", "localhost.example.com", "mylocalhost", "localtest.me"]) expect(namesThisMachine(host), host).toBe(false);
  });
});
