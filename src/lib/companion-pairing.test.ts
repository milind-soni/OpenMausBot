import { describe, expect, it } from "vitest";
import { companionPairingLink } from "./companion-pairing";

describe("companionPairingLink", () => {
  const token = `omb_pair_${"a".repeat(43)}`;

  it("carries the dialable address, one-time token, fallback code, and display name", () => {
    const link = companionPairingLink({
      address: "macbook.tail1234.ts.net",
      port: 8810,
      code: "004209",
      token,
      name: "Milind's Mac",
    });

    const url = new URL(link!);
    expect(url.protocol).toBe("openmausbot:");
    expect(url.host).toBe("pair");
    expect(url.searchParams.get("address")).toBe("macbook.tail1234.ts.net:8810");
    expect(url.searchParams.get("token")).toBe(token);
    expect(url.searchParams.get("code")).toBe("004209");
    expect(url.searchParams.get("name")).toBe("Milind's Mac");
  });

  it("refuses to make a link from an invalid pairing window", () => {
    expect(companionPairingLink({ address: "", port: 8810, code: "123456", token })).toBeNull();
    expect(companionPairingLink({ address: "mac.local", port: 0, code: "123456", token })).toBeNull();
    expect(companionPairingLink({ address: "mac.local", port: 8810, code: "12345", token })).toBeNull();
    expect(companionPairingLink({ address: "mac.local", port: 8810, code: "123456", token: "weak" })).toBeNull();
  });

  it("makes an IPv6 address unambiguous", () => {
    const link = companionPairingLink({ address: "2001:db8::1", port: 8810, code: "123456", token });
    expect(new URL(link!).searchParams.get("address")).toBe("[2001:db8::1]:8810");
  });

  it("carries the ordered fallback hosts, comma-joined", () => {
    const link = companionPairingLink({
      address: "macbook.tail1234.ts.net",
      port: 8810,
      code: "004209",
      token,
      hosts: ["macbook.tail1234.ts.net", "192.168.1.42", "openmausbot-abcd1234.local"],
    });
    expect(new URL(link!).searchParams.get("hosts")).toBe(
      "macbook.tail1234.ts.net,192.168.1.42,openmausbot-abcd1234.local",
    );
  });

  it("drops unusable fallback hosts without breaking the link", () => {
    // A bad candidate costs the phone one failed dial at most, and an empty
    // list is a link that simply carries no fallbacks — pairing still works.
    const link = companionPairingLink({
      address: "mac.local",
      port: 8810,
      code: "004209",
      token,
      hosts: ["  192.168.1.42  ", "", "has space", "has/slash", "a,b"],
    });
    const url = new URL(link!);
    expect(url.searchParams.get("hosts")).toBe("192.168.1.42");
    expect(url.searchParams.get("address")).toBe("mac.local:8810");

    const none = companionPairingLink({ address: "mac.local", port: 8810, code: "004209", token, hosts: [] });
    expect(new URL(none!).searchParams.get("hosts")).toBeNull();
  });
});
