import { describe, expect, it } from "vitest";

import { APP_DOMAIN_LIMIT, BOT_HTML_CSP, BOT_HTML_NETWORK, filterAppDomains, mcpAppCsp, mcpAppNetwork, normalizeAppDomain } from "./csp.ts";

const strict = { websockets: false, loopback: false };
const connect = { websockets: true, loopback: false };

describe("the bot-HTML policy", () => {
  it("is the spec's policy byte for byte", () => {
    expect(BOT_HTML_CSP).toBe(
      "default-src 'none'; " +
      "script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; " +
      "style-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://fonts.googleapis.com; " +
      "font-src data: https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://fonts.gstatic.com; " +
      "img-src data: blob: https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; " +
      "media-src data: blob:; " +
      "connect-src https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; " +
      "worker-src blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; manifest-src 'none'",
    );
  });

  it("lists the same hosts as its network set, for the phones' second lock", () => {
    expect(BOT_HTML_NETWORK).toEqual({
      connect: ["https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net", "https://unpkg.com"],
      resources: ["https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net", "https://unpkg.com", "https://fonts.googleapis.com", "https://fonts.gstatic.com"],
    });
    for (const host of [...BOT_HTML_NETWORK.connect, ...BOT_HTML_NETWORK.resources]) expect(BOT_HTML_CSP).toContain(host);
  });
});

describe("the MCP-app policy", () => {
  it("is the spec's construction byte for byte", () => {
    expect(mcpAppCsp({ connect: ["https://api.example.com", "wss://live.example.com"], resources: ["https://esm.sh", "https://*.cdn.example.com"] })).toBe(
      "default-src 'none'; " +
      "script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https://esm.sh https://*.cdn.example.com; " +
      "style-src 'unsafe-inline' https://esm.sh https://*.cdn.example.com; " +
      "font-src data: https://esm.sh https://*.cdn.example.com; " +
      "img-src data: blob: https://esm.sh https://*.cdn.example.com; " +
      "media-src data: blob: https://esm.sh https://*.cdn.example.com; " +
      "connect-src https://api.example.com wss://live.example.com; " +
      "worker-src blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
    );
  });

  it("allows no network at all when nothing was declared", () => {
    expect(mcpAppCsp({ connect: [], resources: [] })).toBe(
      "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; " +
      "font-src data:; img-src data: blob:; media-src data: blob:; connect-src 'none'; worker-src blob:; " +
      "frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
    );
    expect(mcpAppNetwork(undefined, false)).toEqual({ csp: mcpAppCsp({ connect: [], resources: [] }), network: { connect: [], resources: [] } });
  });

  it("builds Excalidraw's policy from its resource meta, ignoring frame and base domains", () => {
    const built = mcpAppNetwork({ resourceDomains: ["https://esm.sh"], connectDomains: ["https://esm.sh"], frameDomains: ["https://evil.example"], baseUriDomains: ["https://evil.example"] }, false);
    expect(built.network).toEqual({ connect: ["https://esm.sh"], resources: ["https://esm.sh"] });
    expect(built.csp).toContain("connect-src https://esm.sh;");
    expect(built.csp).toContain("frame-src 'none'");
    expect(built.csp).toContain("base-uri 'none'");
    expect(built.csp).not.toContain("evil");
    expect(built.csp).not.toContain("'self'");
  });
});

describe("the domain filter", () => {
  it("keeps https origins with a dotted host, a port, or a leftmost wildcard", () => {
    for (const [input, kept] of [
      ["https://esm.sh", "https://esm.sh"],
      ["https://API.Example.com", "https://api.example.com"],
      ["https://example.com:8443", "https://example.com:8443"],
      ["https://*.example.com", "https://*.example.com"],
      ["https://example.com/", "https://example.com"],
      ["https://xn--bcher-kva.example", "https://xn--bcher-kva.example"],
      ["https://10.0.0.1", "https://10.0.0.1"],
    ] as const) expect(normalizeAppDomain(input, strict), input).toBe(kept);
  });

  it("keeps wss only in connect lists", () => {
    expect(normalizeAppDomain("wss://live.example.com", connect)).toBe("wss://live.example.com");
    expect(normalizeAppDomain("wss://live.example.com", strict)).toBeNull();
  });

  it("never lets a path, query, quote, semicolon, whitespace, bare star, http or a bare host into a policy", () => {
    const hostile = [
      "https://example.com/path", "https://example.com/a/b", "https://example.com?x=1", "https://example.com#top",
      "https://example.com'", "'unsafe-eval'", "https://example.com; script-src *", "https://exa mple.com", "https://example.com\n",
      "*", "https://*", "https://*.com", "*.example.com", "https://foo.*.example.com", "http://example.com",
      "http://localhost", "http://127.0.0.1:3000", "https://localhost", "https://intranet", "https://user:pass@example.com",
      "https://user@example.com", "javascript:alert(1)", "data:", "blob:", "ws://example.com", "ftp://example.com",
      "https://example.com:99999", "https://example.com:0", "https://example.com:abc", "https://[::1]", "https://-bad.example.com",
      "https://example.com,https://other.com", "https://example.com\\@evil.com", "https:///example.com", "",
    ];
    const { kept, refused } = filterAppDomains(hostile, connect);
    expect(kept).toEqual([]);
    expect(refused).toHaveLength(hostile.length);
    const policy = mcpAppCsp({ connect: kept, resources: kept });
    for (const fragment of ["example", "localhost", "127.0.0.1", "javascript", "ftp", "*"]) expect(policy).not.toContain(fragment);
  });

  it("keeps loopback http origins only for a command or loopback server", () => {
    const loopback = { websockets: true, loopback: true };
    expect(filterAppDomains(["http://localhost:5173", "http://127.0.0.1", "http://localhost.evil.com", "http://192.168.1.2"], loopback)).toEqual({
      kept: ["http://localhost:5173", "http://127.0.0.1"],
      refused: ["http://localhost.evil.com", "http://192.168.1.2"],
    });
    expect(filterAppDomains(["http://localhost:5173"], connect).kept).toEqual([]);
  });

  it("keeps at most 16, refuses the rest, dedupes, and drops non-strings without a trace", () => {
    const many = Array.from({ length: 20 }, (_, index) => `https://h${index}.example.com`);
    const { kept, refused } = filterAppDomains([...many, "https://h0.example.com", 7, null, { url: "https://x.example.com" }], strict);
    expect(kept).toHaveLength(APP_DOMAIN_LIMIT);
    expect(refused).toEqual(many.slice(APP_DOMAIN_LIMIT));
    expect(filterAppDomains("https://esm.sh", strict)).toEqual({ kept: [], refused: [] });
  });

  it("clips a refused entry and strips control characters before the popover shows it", () => {
    const { refused } = filterAppDomains([`https://example.com/${"a".repeat(500)}`, "https://x.example.com/\u0007bell"], strict);
    expect(refused[0]!.length).toBeLessThanOrEqual(120);
    expect(refused[1]).toBe("https://x.example.com/ bell");
  });

  it("reports what it refused with the network set", () => {
    expect(mcpAppNetwork({ connectDomains: ["https://api.example.com", "http://evil.example"], resourceDomains: ["https://cdn.example.com/lib.js"] }, false).network).toEqual({
      connect: ["https://api.example.com"],
      resources: [],
      refused: ["http://evil.example", "https://cdn.example.com/lib.js"],
    });
  });
});
