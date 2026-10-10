import { describe, expect, it } from "vitest";
import { phonePairingLink } from "./pairing-link";

describe("phonePairingLink", () => {
  const token = `omb_pair_${"a".repeat(43)}`;
  const secretPublicKey = "BIPBQ12_dWnF1DZLsTZO3Vg0NGjds5-jp9h3jhjr2To7bJelczS0LM82rfXV68PmSJhz2ePosj3fL974XckCpDU";

  const decodedEndpoints = (link: string) => {
    const encoded = new URL(link).searchParams.get("endpoints");
    if (!encoded) return null;
    const padded = encoded.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  };

  /** Read one field the way the phones do: split the raw query, then
   * percent-decode. `searchParams.get` would turn a stray "+" into a space
   * and hide exactly the bug this guards. */
  const rawField = (link: string, name: string): string | undefined => {
    const query = link.slice(link.indexOf("?") + 1);
    const item = query.split("&").find((pair) => pair.startsWith(`${name}=`));
    return item === undefined ? undefined : decodeURIComponent(item.slice(name.length + 1));
  };

  it("carries the dialable address, one-time token, fallback code, and display name", () => {
    const link = phonePairingLink({
      address: "macbook.tail1234.ts.net",
      port: 8810,
      code: "004209",
      token,
      name: "Milind's Mac",
      secretPublicKey,
    });

    const url = new URL(link!);
    expect(url.protocol).toBe("openmausbot:");
    expect(url.host).toBe("pair");
    expect(url.searchParams.get("address")).toBe("macbook.tail1234.ts.net:8810");
    expect(url.searchParams.get("token")).toBe(token);
    expect(url.searchParams.get("code")).toBe("004209");
    expect(url.searchParams.get("name")).toBe("Milind's Mac");
    expect(url.searchParams.get("secretKey")).toBe(secretPublicKey);
  });

  it("omits malformed secure-entry keys instead of advertising an unusable key", () => {
    const base = { address: "mac.local", port: 8810, code: "123456", token };
    expect(new URL(phonePairingLink({ ...base, secretPublicKey: secretPublicKey.slice(1) })!)
      .searchParams.get("secretKey")).toBeNull();
    expect(new URL(phonePairingLink({ ...base, secretPublicKey: `A${secretPublicKey.slice(1)}` })!)
      .searchParams.get("secretKey")).toBeNull();
  });

  it("refuses to make a link from an invalid pairing window", () => {
    expect(phonePairingLink({ address: "", port: 8810, code: "123456", token })).toBeNull();
    expect(phonePairingLink({ address: "mac.local", port: 0, code: "123456", token })).toBeNull();
    expect(phonePairingLink({ address: "mac.local", port: 8810, code: "12345", token })).toBeNull();
    expect(phonePairingLink({ address: "mac.local", port: 8810, code: "123456", token: "weak" })).toBeNull();
  });

  it("makes an IPv6 address unambiguous", () => {
    const link = phonePairingLink({ address: "2001:db8::1", port: 8810, code: "123456", token });
    expect(new URL(link!).searchParams.get("address")).toBe("[2001:db8::1]:8810");
  });

  it("carries the ordered fallback hosts, comma-joined", () => {
    const link = phonePairingLink({
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

  it("carries sorted typed endpoints as URL-safe base64 JSON while preserving legacy fields", () => {
    const link = phonePairingLink({
      address: "192.168.1.42",
      port: 8810,
      code: "004209",
      token,
      hosts: ["192.168.1.42", "openmausbot-abcd1234.local"],
      endpoints: [
        { url: "http://192.168.1.42:8810", kind: "lan", priority: 200 },
        { url: "https://Device-123.Companion.Example/", kind: "hosted", priority: 0 },
        { url: "http://openmausbot-abcd1234.local:8810", kind: "bonjour", priority: 300 },
      ],
    });

    const url = new URL(link!);
    expect(url.searchParams.get("address")).toBe("192.168.1.42:8810");
    expect(url.searchParams.get("hosts")).toBe("192.168.1.42,openmausbot-abcd1234.local");
    expect(url.searchParams.get("endpoints")).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodedEndpoints(link!)).toEqual([
      { url: "https://device-123.companion.example", kind: "hosted", priority: 0 },
      { url: "http://192.168.1.42:8810", kind: "lan", priority: 200 },
      { url: "http://openmausbot-abcd1234.local:8810", kind: "bonjour", priority: 300 },
    ]);
  });

  it("filters malformed or transport-mismatched typed endpoints", () => {
    const link = phonePairingLink({
      address: "mac.local",
      port: 8810,
      code: "004209",
      token,
      endpoints: [
        { url: "http://hosted.example", kind: "hosted", priority: 0 },
        { url: "https://192.168.1.42:8810", kind: "lan", priority: 200 },
        { url: "http://mac.local:8810/path", kind: "bonjour", priority: 300 },
        { url: "http://mac.local:0", kind: "bonjour", priority: 300 },
        { url: "http://mac.local:65536", kind: "bonjour", priority: 300 },
        // An empty DNS label: a bare ".ts.net" fails both phones'
        // validTailnetHost, and java.net.URI on Android reads no host at all
        // from "a..ts.net" or "mac..local". Android then refuses the whole list.
        { url: "http://.ts.net:8810", kind: "tailnet", priority: 100 },
        { url: "http://a..ts.net:8810", kind: "tailnet", priority: 100 },
        { url: "http://mac..local:8810", kind: "bonjour", priority: 300 },
        { url: "http://mac.local:8810", kind: "bonjour", priority: 300 },
      ],
    });
    expect(decodedEndpoints(link!)).toEqual([
      { url: "http://mac.local:8810", kind: "bonjour", priority: 300 },
    ]);
  });

  it("drops unusable fallback hosts without breaking the link", () => {
    // A bad candidate costs the phone one failed dial at most, and an empty
    // list is a link that simply carries no fallbacks — pairing still works.
    const link = phonePairingLink({
      address: "mac.local",
      port: 8810,
      code: "004209",
      token,
      hosts: ["  192.168.1.42  ", "", "has space", "has/slash", "a,b"],
    });
    const url = new URL(link!);
    expect(url.searchParams.get("hosts")).toBe("192.168.1.42");
    expect(url.searchParams.get("address")).toBe("mac.local:8810");

    const none = phonePairingLink({ address: "mac.local", port: 8810, code: "004209", token, hosts: [] });
    expect(new URL(none!).searchParams.get("hosts")).toBeNull();
  });

  // Oct 3: an Android phone showed "Miguel's+computer". URLSearchParams
  // writes a space as "+", which is form encoding; the phones percent-decode.
  it("writes a space as %20, never +, so a phone shows the name it was given", () => {
    const link = phonePairingLink({ address: "192.168.1.34", port: 8810, code: "004209", token, name: "Miguel's computer" })!;
    expect(link).toContain("name=Miguel's%20computer");
    expect(link).not.toContain("+");
    expect(rawField(link, "name")).toBe("Miguel's computer");
    // a real plus survives as %2B
    expect(rawField(phonePairingLink({ address: "mac.local", port: 8810, token, name: "C++ box" })!, "name")).toBe("C++ box");
  });

  it("is the server's link too: an https origin, a credential, a name and no code", () => {
    const link = phonePairingLink({ address: "https://mini.example", token, name: "Ada's server" })!;
    expect(link).toBe(`openmausbot://pair?address=https%3A%2F%2Fmini.example&token=${token}&name=Ada's%20server`);
    expect(rawField(link, "code")).toBeUndefined();
    expect(phonePairingLink({ address: "http://192.168.1.5:8787", token })).toBe(
      `openmausbot://pair?address=http%3A%2F%2F192.168.1.5%3A8787&token=${token}`,
    );
  });

  it("refuses an origin carrying credentials, and a host with no port", () => {
    expect(phonePairingLink({ address: "https://user:pass@mini.example", token })).toBeNull();
    expect(phonePairingLink({ address: "mini.example", token })).toBeNull();
  });

  // Both phones refuse an address with a path, query or fragment (Android
  // Endpoint.kt normalizedUrl, iOS CompanionEndpoint), so the builder does too
  // rather than print a QR the scanner calls "not a pairing code".
  it("writes an origin as its bare origin and refuses one with a path, query or fragment", () => {
    expect(rawField(phonePairingLink({ address: "https://Mini.Example:443/", token })!, "address")).toBe(
      "https://mini.example",
    );
    expect(phonePairingLink({ address: "https://mini.example/omb", token })).toBeNull();
    expect(phonePairingLink({ address: "https://mini.example/?x=1", token })).toBeNull();
    expect(phonePairingLink({ address: "https://mini.example/#pair", token })).toBeNull();
  });
});
