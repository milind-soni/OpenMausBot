import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Agent, fetch as directFetch } from "undici";
import { afterEach, describe, expect, it } from "vitest";

import { bypassesProxy, plainHttpProxyFetch, RemoteMcpClient } from "./mcp-http.ts";
import { startFakeHttpMcp, type FakeHttpMcp } from "./testing/fake-http-mcp-server.ts";

describe("NO_PROXY CIDR entries", () => {
  it.each([
    ["http://192.168.42.7/mcp", "192.168.0.0/16", true],
    ["http://192.168.0.0/mcp", "192.168.0.0/16", true],
    ["http://192.168.255.255/mcp", "192.168.0.0/16", true],
    ["http://192.169.0.0/mcp", "192.168.0.0/16", false],
    ["http://10.1.2.3:8123/mcp", "10.1.2.3/32", true],
    ["http://10.1.2.4/mcp", "10.1.2.3/32", false],
    ["http://203.0.113.4/mcp", "0.0.0.0/0", true],
    ["http://192.168.42.7/mcp", "192.168.42.99/24", true],
    ["http://[fd12:3456:789a::abcd]/mcp", "fd12:3456:789a::/48", true],
    ["http://[fd12:3456:789b::]/mcp", "fd12:3456:789a::/48", false],
    ["http://[fd12:3456:789a:ffff:ffff:ffff:ffff:ffff]/mcp", "fd12:3456:789a::/48", true],
    ["http://[fd12::1]/mcp", "FD12:0000:0000:0000:0000:0000:0000:0001/128", true],
    ["http://[fd12::2]/mcp", "fd12::1/128", false],
    ["http://[2001:db8::1]/mcp", "::/0", true],
    ["http://[::ffff:192.0.2.8]/mcp", "::ffff:192.0.2.0/120", true],
    ["http://[::ffff:192.0.2.8]/mcp", "192.0.2.0/24", false],
    ["http://192.0.2.8/mcp", "::ffff:192.0.2.0/120", false],
    ["http://192.0.2.8/mcp", "::/0", false],
    ["http://[fd12::1]/mcp", "0.0.0.0/0", false],
    ["http://mcp.corp.internal/mcp", "0.0.0.0/0,::/0", false],
    ["http://192.168.42.7/mcp", "other.internal,\n192.168.0.0/16,elsewhere.test", true],
    ["http://mcp.corp.internal:8123/mcp", "192.168.0.0/16,corp.internal:8123", true],
  ] as const)("matches %s against %s: %s", (url, entry, expected) => {
    expect(bypassesProxy(new URL(url), entry)).toBe(expected);
  });

  it.each([
    "192.168.0.0/33", "192.168.0.0/-1", "192.168.0.0/1.5", "192.168.0.0/",
    "192.168.0.0/nope", "192.168.0.0/9999999999999999999999999999999999999",
    "192.168.0.999/16", "192.168.0.0/16:80", "corp.internal/0",
    "fd12::/129", "fd12::/-1", "fd12::/word", "[fd12::]/16", "fe80::1%eth0/0",
  ])("ignores invalid or non-address CIDR %s without breaking later entries", (entry) => {
    for (const url of ["http://192.168.42.7/mcp", "http://[fd12::1]/mcp"]) {
      expect(bypassesProxy(new URL(url), entry)).toBe(false);
    }
    expect(bypassesProxy(new URL("http://mcp.corp.internal/mcp"), `${entry},corp.internal`)).toBe(true);
  });

  it("keeps the existing loopback, domain, wildcard and explicit-port rules", () => {
    expect(bypassesProxy(new URL("http://127.1.2.3/mcp"), "")).toBe(true);
    expect(bypassesProxy(new URL("http://[::1]/mcp"), "")).toBe(true);
    expect(bypassesProxy(new URL("http://mcp.corp.internal/mcp"), "*.corp.internal")).toBe(true);
    expect(bypassesProxy(new URL("http://notcorp.internal/mcp"), ".corp.internal")).toBe(false);
    expect(bypassesProxy(new URL("http://mcp.corp.internal:8123/mcp"), "corp.internal:8124")).toBe(false);
    expect(bypassesProxy(new URL("http://mcp.corp.internal/mcp"), "*")).toBe(true);
    expect(bypassesProxy(new URL("http://[fd12::1]:8123/mcp"), "[fd12::1]:8123")).toBe(true);
  });
});

let upstream: FakeHttpMcp | undefined;
let proxy: Server | undefined;
let agent: Agent | undefined;
let client: RemoteMcpClient | undefined;

afterEach(async () => {
  await client?.close(); client = undefined;
  await upstream?.close(); upstream = undefined;
  await agent?.close(); agent = undefined;
  if (proxy) {
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy!.close(() => resolve()));
    proxy = undefined;
  }
});

async function connect(transport: "http" | "sse", variable: "NO_PROXY" | "no_proxy", entry: string) {
  upstream = await startFakeHttpMcp({ transport, tools: [{ name: "private_tool" }] });
  let proxyRequests = 0;
  proxy = createServer((_req, res) => {
    proxyRequests += 1;
    res.writeHead(503, { "content-type": "text/plain" });
    res.end("this proxy cannot reach the private MCP server");
  });
  await new Promise<void>((resolve) => proxy!.listen(0, "127.0.0.1", resolve));
  const proxyPort = (proxy.address() as AddressInfo).port;
  agent = new Agent();
  const dispatcher = agent;
  const fallback: typeof fetch = (input, init) => directFetch(String(input), {
    method: init?.method,
    headers: Array.from(new Headers(init?.headers).entries()),
    body: typeof init?.body === "string" ? init.body : undefined,
    signal: init?.signal ?? undefined,
    dispatcher,
  }) as unknown as Promise<Response>;
  const viaProxy = plainHttpProxyFetch({ HTTP_PROXY: `http://127.0.0.1:${proxyPort}`, [variable]: entry }, fallback)!;
  const target = new URL(upstream.url);
  target.hostname = "[::ffff:127.0.0.1]";
  client = new RemoteMcpClient({ type: transport, url: target.href, headers: {} }, { fetch: viaProxy });
  return { client, upstream, proxyRequests: () => proxyRequests };
}

describe("private MCP servers behind an HTTP proxy", () => {
  for (const transport of ["http", "sse"] as const) {
    it.each(["NO_PROXY", "no_proxy"] as const)(`${transport} reaches a CIDR-exempt server through %s`, async (variable) => {
      const fixture = await connect(transport, variable, "unused.example,::ffff:127.0.0.0/120");
      await fixture.client.initialize("cidr-fixture", AbortSignal.timeout(2_000));
      await expect(fixture.client.request("tools/list", {}, AbortSignal.timeout(2_000))).resolves.toEqual({ tools: [{ name: "private_tool" }] });
      expect(fixture.upstream.initializes).toHaveLength(1);
      expect(fixture.upstream.toolsLists).toBe(1);
      expect(fixture.proxyRequests()).toBe(0);
    });

    it(`${transport} still uses the proxy for an address outside the configured CIDR`, async () => {
      const fixture = await connect(transport, "NO_PROXY", "::ffff:127.0.1.0/120");
      await expect(fixture.client.initialize("cidr-fixture", AbortSignal.timeout(2_000))).rejects.toMatchObject({ status: 503 });
      expect(fixture.upstream.initializes).toHaveLength(0);
      expect(fixture.proxyRequests()).toBe(1);
    });
  }
});
