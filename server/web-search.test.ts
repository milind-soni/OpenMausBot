import { createServer, request as httpRequest, type OutgoingHttpHeaders, type RequestOptions, type Server } from "node:http";
import type { request as httpsRequest } from "node:https";
import type { AddressInfo, LookupFunction } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSearchResults, searchWeb, type WebSearchOptions } from "./web-search.ts";

const brave = { braveApiKey: "synthetic-brave-secret" };
const searxng = { searxngUrl: "http://search.local/base/", ...brave };
const hit = { title: "café", url: "https://example.com/guide", content: "SearXNG source", description: "Brave source" };
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.closeAllConnections(); server.close(error => error ? reject(error) : resolve());
  })));
});
async function fixture(body: string | Buffer = JSON.stringify({ results: [hit], web: { results: [hit] } }), status = 200, type = "application/json", headers: OutgoingHttpHeaders = {}) {
  const server = createServer((_req, res) => { res.writeHead(status, { "content-type": type, location: "http://127.0.0.1/private", ...headers }); res.end(body); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const targets: URL[] = []; const settings: RequestOptions[] = [];
  const request = ((url: URL, options: RequestOptions, listener: Parameters<typeof httpRequest>[2]) => {
    targets.push(url); settings.push(options);
    return httpRequest(`http://127.0.0.1:${(server.address() as AddressInfo).port}${url.pathname}${url.search}`, { ...options, lookup: undefined }, listener);
  }) as typeof httpsRequest;
  return { server, targets, settings, options: { request, resolve: async () => [{ address: "93.184.216.34", family: 4 }] } satisfies WebSearchOptions };
}

describe("configured JSON web search", () => {
  it("uses the fixed Brave HTTPS API and pins the public address", async () => {
    const f = await fixture();
    expect(await searchWeb(brave, "cats & dogs", 1, undefined, f.options)).toEqual([{ title: "café", url: hit.url, snippet: "Brave source" }]);
    expect(f.targets[0].origin + f.targets[0].pathname).toBe("https://api.search.brave.com/res/v1/web/search");
    expect(f.targets[0].searchParams.get("q")).toBe("cats & dogs");
    expect(f.targets[0].searchParams.get("count")).toBe("1");
    expect(f.settings[0]).toMatchObject({ agent: false, headers: { "X-Subscription-Token": brave.braveApiKey, accept: "application/json" } });
    expect(f.settings[0].headers).not.toHaveProperty("cookie");
    const done = vi.fn(); (f.settings[0].lookup as LookupFunction)("api.search.brave.com", {}, done);
    expect(done).toHaveBeenCalledWith(null, "93.184.216.34", 4);
  });
  it("prefers owner-set SearXNG, allows private HTTP, and never sends the Brave key", async () => {
    const f = await fixture();
    expect(await searchWeb(searxng, "cats", 5, undefined, { ...f.options, resolve: async () => [{ address: "10.0.0.2", family: 4 }] })).toEqual([{ title: "café", url: hit.url, snippet: "SearXNG source" }]);
    expect(f.targets[0].href).toBe("http://search.local/base/search?q=cats&format=json");
    expect(f.settings[0].headers).not.toHaveProperty("X-Subscription-Token");
  });
  it("does not offer a default backend or fall back after SearXNG errors", async () => {
    const f = await fixture("Forbidden", 403, "text/html");
    await expect(searchWeb(undefined, "test", 5, undefined, f.options)).rejects.toThrow("Configure");
    expect(f.targets).toHaveLength(0);
    await expect(searchWeb({ ...searxng, searxngUrl: "https://search.local" }, "test", 5, undefined, f.options)).rejects.toThrow("search.formats");
    expect(f.targets).toHaveLength(1);
  });
  it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "::1", "fd12::1", "::ffff:93.184.216.34", "0:0:0:0:0:ffff:5db8:d822", "64:ff9b::5db8:d822", "64:ff9b:0:0:0:0:5db8:d822", "64:ff9b:1::1", "2002:5db8:d822::1", "2001::5db8:d822", "240.0.0.1", "192.0.2.1", "198.51.100.1", "203.0.113.1", "2001:db8::1", "2001:20::1", "3fff::1"])("refuses mixed Brave DNS answer %s before a connection", async address => {
    const request = vi.fn();
    await expect(searchWeb(brave, "test", 5, undefined, { request: request as typeof httpsRequest, resolve: async () => [{ address: "93.184.216.34", family: 4 }, { address, family: address.includes(":") ? 6 : 4 }] })).rejects.toThrow("not public");
    expect(request).not.toHaveBeenCalled();
  });
  it("requires every HTTP SearXNG address to be private but trusts owner-set HTTPS", async () => {
    const f = await fixture();
    await expect(searchWeb(searxng, "test", 5, undefined, f.options)).rejects.toThrow("HTTP requires");
    expect(f.targets).toHaveLength(0);
    expect(await searchWeb({ searxngUrl: "https://private.local" }, "test", 5, undefined, { ...f.options, resolve: async () => [{ address: "127.0.0.1", family: 4 }] })).toHaveLength(1);
  });
  it.each([302, 202, 503])("refuses HTTP %s without redirects", async status => {
    const f = await fixture("{}", status);
    await expect(searchWeb(brave, "test", 5, undefined, f.options)).rejects.toThrow("unavailable");
    expect(f.targets).toHaveLength(1);
  });
  it.each([401, 403, 429])("reports Brave HTTP %s without exposing the key or body or retrying", async status => {
    const f = await fixture(`key=${brave.braveApiKey}; synthetic-response-secret`, status, "text/html");
    const message = await searchWeb(brave, "test", 5, undefined, f.options).catch((error: Error) => error.message);
    expect(message).toBe(status === 429
      ? "Brave quota or rate limit reached. Try again later or check your Brave API plan."
      : "The Brave key was rejected. Check your Brave Search API key.");
    expect(message).not.toContain(brave.braveApiKey);
    expect(message).not.toContain("synthetic-response-secret");
    expect(f.targets).toHaveLength(1);
  });
  it.each([
    [{ "retry-after": "12", "x-ratelimit-reset": "1, 300" }, 12],
    [{ "retry-after": "HTTP-date" }, 60],
    [{ "x-ratelimit-remaining": "0, 10", "x-ratelimit-reset": "1, 300" }, 1],
    [{ "x-ratelimit-remaining": "1, 0", "x-ratelimit-reset": "1, 300" }, 300],
    [{ "x-ratelimit-remaining": "0, 0", "x-ratelimit-reset": "1, 300" }, 300],
    [{ "x-ratelimit-reset": "1, 300" }, 300],
    [{ "retry-after": "synthetic-header-secret", "x-ratelimit-reset": "5" }, 5],
  ] satisfies Array<[OutgoingHttpHeaders, number]>)("provides a safe Brave retry delay from %j", async (headers: OutgoingHttpHeaders, seconds) => {
    const dated = headers["retry-after"] === "HTTP-date";
    if (dated) headers = { ...headers, "retry-after": new Date(Date.now() + 60_000).toUTCString() };
    const f = await fixture("synthetic-response-secret", 429, "text/plain", headers);
    const message = await searchWeb(brave, "test", 5, undefined, f.options).catch((error: Error) => error.message);
    if (dated) {
      expect(message).toMatch(/Brave quota or rate limit reached\. Retry after (59|60) seconds\./);
    } else expect(message).toBe(`Brave quota or rate limit reached. Retry after ${seconds} seconds.`);
    expect(f.targets).toHaveLength(1);
  });
  it.each([
    { "retry-after": brave.braveApiKey, "x-ratelimit-reset": "synthetic-header-secret" },
    { "retry-after": "Invalid Date" },
    { "retry-after": "-1", "x-ratelimit-reset": "1, Infinity" },
    { "retry-after": "9".repeat(1000), "x-ratelimit-reset": "-2" },
  ])("does not reflect invalid Brave retry headers %j", async headers => {
    const f = await fixture("synthetic-response-secret", 429, "application/json", headers);
    const message = await searchWeb(brave, "test", 5, undefined, f.options).catch((error: Error) => error.message);
    expect(message).toBe("Brave quota or rate limit reached. Try again later or check your Brave API plan.");
    expect(f.targets).toHaveLength(1);
  });
  it("keeps SearXNG rate failures generic without retrying or falling back to Brave", async () => {
    const f = await fixture("synthetic-response-secret", 429, "application/json", { "retry-after": "12" });
    await expect(searchWeb({ ...searxng, searxngUrl: "https://search.local" }, "test", 5, undefined, f.options)).rejects.toThrow("Web search is unavailable");
    expect(f.targets).toHaveLength(1);
    expect(f.settings[0].headers).not.toHaveProperty("X-Subscription-Token");
  });
  it("skips missing, relative, executable, credential-bearing and duplicate URLs without inventing hits", () => {
    const rows = [undefined, "", "/relative", "javascript:alert(1)", "data:text/html,x", "https://name:secret@example.com/", "http://[invalid", hit.url, hit.url].map(url => ({ ...hit, url }));
    expect(parseSearchResults(JSON.stringify({ results: rows, comment: hit }), "searxng", 10)).toEqual([{ title: hit.title, url: hit.url, snippet: hit.content }]);
    expect(parseSearchResults('{"results":[]}', "searxng", 5)).toEqual([]);
    expect(() => parseSearchResults('{"comment":[]}', "searxng", 5)).toThrow("unsupported");
  });
  it("bounds output and rejects malformed JSON, HTML, charsets and malformed UTF-8", async () => {
    expect(parseSearchResults(JSON.stringify({ web: { results: [{ ...hit, title: "a".repeat(500), description: "s".repeat(2000) }, { ...hit, url: "https://example.org" }] } }), "brave", 1)).toEqual([{ title: "a".repeat(300), url: hit.url, snippet: "s".repeat(1000) }]);
    for (const [body, type] of [["{", "application/json"], ["<html>challenge</html>", "text/html"], [JSON.stringify({ web: { results: [hit] } }), "application/json; charset=iso-8859-1"], [Buffer.concat([Buffer.from('{"web":{"results":[{"title":"caf'), Buffer.from([0xe9]), Buffer.from('","url":"https://example.com/"}]}}')]), "application/json"]] as const) {
      const f = await fixture(body, 200, type);
      await expect(searchWeb(brave, "test", 5, undefined, f.options)).rejects.toThrow();
    }
    const f = await fixture();
    await expect(searchWeb(brave, "test", 5, undefined, { ...f.options, maxBytes: 10 })).rejects.toThrow("too large");
  });
  it("bounds DNS, streaming, cancellation and elapsed time even when the abort timer has not fired", async () => {
    const f = await fixture();
    await expect(searchWeb(brave, "test", 5, undefined, { ...f.options, timeoutMs: 30, resolve: () => new Promise(() => {}) })).rejects.toThrow();
    f.server.removeAllListeners("request"); f.server.on("request", (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write("{"); });
    await expect(searchWeb(brave, "test", 5, undefined, { ...f.options, timeoutMs: 30 })).rejects.toThrow();
    const stop = new AbortController(); const pending = searchWeb(brave, "test", 5, stop.signal, f.options); stop.abort();
    await expect(pending).rejects.toThrow();
    const request = vi.fn();
    await expect(searchWeb(brave, "test", 5, undefined, { request: request as typeof httpsRequest, timeoutMs: 10, resolve: async () => {
      const until = performance.now() + 30; while (performance.now() < until) { /* Deliberately block timer delivery. */ }
      return [{ address: "93.184.216.34", family: 4 }];
    } })).rejects.toThrow("timed out");
    expect(request).not.toHaveBeenCalled();
  });
  it("rechecks authorization after DNS before connecting", async () => {
    const f = await fixture(); let allowed = true;
    await expect(searchWeb(brave, "test", 5, undefined, { ...f.options, resolve: async () => { allowed = false; return [{ address: "93.184.216.34", family: 4 }]; }, assertAllowed: () => { if (!allowed) throw new Error("revoked"); } })).rejects.toThrow("revoked");
    expect(f.targets).toEqual([]);
  });
});

it("checks the elapsed deadline after JSON parsing before returning success", async () => {
  const f = await fixture();
  const parse = JSON.parse;
  const spy = vi.spyOn(JSON, "parse").mockImplementation((body: string) => {
    const result = parse(body);
    const until = performance.now() + 50;
    while (performance.now() < until) { /* Simulate synchronous work across the deadline. */ }
    return result;
  });
  try { await expect(searchWeb(brave, "test", 5, undefined, { ...f.options, timeoutMs: 40 })).rejects.toThrow("timed out"); }
  finally { spy.mockRestore(); }
});
