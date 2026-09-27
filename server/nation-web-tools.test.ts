import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { blockedAddress, htmlToText, searchProvider, webRead, webSearch, webToolsStatus, WebToolError } from "./nation-web-tools.ts";

describe("which provider backs web search", () => {
  it("prefers the admin's saved choice, then the API environment, then NATION API web search", () => {
    const env = { OPENROUTER_API_KEY: "or_key", NATION_SEARCH_PROVIDER: "brave", NATION_SEARCH_API_KEY: "env_key" };
    expect(searchProvider({ webSearch: { provider: "tavily", apiKey: "admin_key" } }, env)).toMatchObject({ kind: "tavily", key: "admin_key" });
    expect(searchProvider({ webSearch: { provider: "openrouter" } }, env)).toMatchObject({ kind: "openrouter", key: "or_key" });
    expect(searchProvider({}, env)).toMatchObject({ kind: "brave", key: "env_key" });
    expect(searchProvider({}, { OPENROUTER_API_KEY: "or_key" })).toMatchObject({ kind: "openrouter" });
    // an environment that names a provider without its key does not silently switch to another
    expect(searchProvider({}, { OPENROUTER_API_KEY: "or_key", NATION_SEARCH_PROVIDER: "brave" })).toBeNull();
    expect(searchProvider({}, {})).toBeNull();
  });

  it("reports status without the key", () => {
    const status = webToolsStatus({ webSearch: { provider: "brave", apiKey: "admin_secret_key" } }, {});
    expect(status.search).toMatchObject({ configured: true, provider: "brave", source: "admin" });
    expect(JSON.stringify(status)).not.toContain("admin_secret_key");
  });
});

describe("web search", () => {
  const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

  it("normalizes each provider into titles, links and snippets", async () => {
    const brave = await webSearch({ kind: "brave", key: "k", url: "https://x.test" }, "nation",
      3, reply(200, { web: { results: [{ title: "A", url: "https://a.test", description: "alpha" }, { title: "bad", url: "javascript:alert(1)" }] } }));
    expect(brave.results).toEqual([{ title: "A", url: "https://a.test", snippet: "alpha" }]);
    const tavily = await webSearch({ kind: "tavily", key: "k", url: "https://x.test" }, "nation", 3,
      reply(200, { answer: "Summary.", results: [{ title: "B", url: "https://b.test", content: "beta" }] }));
    expect(tavily).toEqual({ results: [{ title: "B", url: "https://b.test", snippet: "beta" }], summary: "Summary." });
    const nation = await webSearch({ kind: "openrouter", key: "k", url: "https://x.test", model: "m" }, "nation", 3,
      reply(200, { choices: [{ message: { content: "Found it.", annotations: [{ type: "url_citation", url_citation: { url: "https://c.test", title: "C", content: "gamma" } }] } }], usage: { cost: 0.0042 } }));
    expect(nation).toEqual({ results: [{ title: "C", url: "https://c.test", snippet: "gamma" }], summary: "Found it.", costUsd: 0.0042 });
  });

  it("fails with NATION words, never the provider's error or name", async () => {
    for (const [status, body] of [[401, { error: "Invalid Brave subscription token sk_live_leak" }], [500, { message: "tavily upstream exploded" }]] as const) {
      const error = await webSearch({ kind: "brave", key: "sk_live_leak", url: "https://x.test" }, "q", 3, reply(status, body)).catch((cause) => cause);
      expect(error).toBeInstanceOf(WebToolError);
      expect(error.message).not.toMatch(/brave|tavily|token|sk_live|key/i);
    }
    const busy = await webSearch({ kind: "brave", key: "k", url: "https://x.test" }, "q", 3, reply(429, {})).catch((cause) => cause);
    expect(busy.message).toMatch(/busy/i);
    await expect(webSearch({ kind: "brave", key: "k", url: "https://x.test" }, "   ", 3, reply(200, {}))).rejects.toThrow(/query/);
  });
});

describe("web reader address rules", () => {
  it("blocks private, loopback, link-local, metadata and special ranges", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
      "::1", "::", "fc00::1", "fd12::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "not-an-ip",
      // every spelling of an embedded IPv4 address is that address
      "::ffff:7f00:1", "0:0:0:0:0:ffff:127.0.0.1", "0000:0000:0000:0000:0000:FFFF:7F00:0001", "::ffff:a9fe:a9fe", "::ffff:0:127.0.0.1",
      "::127.0.0.1", "::7f00:1", "2002:7f00:1::", "2002:a9fe:a9fe::1", "64:ff9b::7f00:1", "64:ff9b:1::1",
      "fe80::1%eth0", "fec0::1", "ff02::1", "2001:db8::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "100::1"]) {
      expect(blockedAddress(address), address).toBe(true);
    }
    for (const address of ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111", "::ffff:93.184.216.34", "::ffff:5db8:d822", "2002:5db8:d822::1"]) {
      expect(blockedAddress(address), address).toBe(false);
    }
    expect(blockedAddress("127.0.0.1", true)).toBe(false);
    expect(blockedAddress("::1", true)).toBe(false);
    expect(blockedAddress("::ffff:7f00:1", true)).toBe(false);
    expect(blockedAddress("2002:7f00:1::", true)).toBe(true);
  });

  it("turns HTML into readable text without scripts or markup", () => {
    const page = htmlToText("<html><head><title>Hi &amp; bye</title><script>steal()</script></head><body><h1>Title</h1><p>One&nbsp;two</p><style>x{}</style><p>&#65;&#x42;</p></body></html>");
    expect(page).toEqual({ title: "Hi & bye", text: "Title\nOne two\nAB" });
  });
});

describe("web reader over HTTP", () => {
  let server: Server;
  let origin = "";
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/page") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end("<title>Fixture</title><p>Readable body</p><script>no()</script>"); }
      if (req.url === "/to-metadata") { res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }); return res.end(); }
      if (req.url === "/to-private") { res.writeHead(302, { location: "http://10.0.0.1/" }); return res.end(); }
      if (req.url === "/binary") { res.writeHead(200, { "content-type": "application/zip" }); return res.end("PK"); }
      if (req.url === "/huge") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("x".repeat(30_000)); }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  it("reads a page", async () => {
    expect(await webRead(`${origin}/page`, { allowLoopback: true })).toMatchObject({ title: "Fixture", text: "Readable body", truncated: false, contentType: "text/html" });
    expect(await webRead(`${origin}/huge`, { allowLoopback: true })).toMatchObject({ truncated: true });
  });

  it("refuses the server's own network, redirects into private space, and non-pages", async () => {
    const refuse = async (url: string, pattern: RegExp, allowLoopback = false) =>
      expect((await webRead(url, { allowLoopback }).catch((cause) => cause)).message).toMatch(pattern);
    await refuse(`${origin}/page`, /can't be read from here/); // loopback, not allowed in production
    await refuse("http://169.254.169.254/latest/meta-data/", /can't be read from here/);
    await refuse("http://[::1]:80/", /can't be read from here/);
    await refuse(`${origin}/to-metadata`, /can't be read from here/, true);
    await refuse(`${origin}/to-private`, /can't be read from here/, true);
    await refuse("file:///etc/passwd", /can't be read from here/);
    await refuse("https://user:pass@example.test/", /can't be read from here/);
    await refuse(`${origin}/binary`, /isn't a readable page/, true);
    await refuse("not a url", /full http\(s\) URL/);
  });
});
