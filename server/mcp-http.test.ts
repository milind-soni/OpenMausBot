// The remote MCP client against a real HTTP server on loopback.
import { afterEach, describe, expect, it } from "vitest";

import { McpRpcError, RemoteMcpClient, bypassesProxy, plainHttpProxyFetch } from "./mcp-http.ts";
import { startFakeHttpMcp, type FakeHttpMcp } from "./testing/fake-http-mcp-server.ts";

let fake: FakeHttpMcp | undefined;
let client: RemoteMcpClient | undefined;
afterEach(async () => {
  await client?.close(); client = undefined;
  await fake?.close(); fake = undefined;
});

describe("a server's own requests to the client", () => {
  it.each(["http", "sse"] as const)("are refused at once over %s, so the call they interrupt still finishes", async (transport) => {
    fake = await startFakeHttpMcp({ transport, tools: [{ name: "ask_first", inputSchema: { type: "object" } }], askOnCall: "elicitation/create" });
    client = new RemoteMcpClient({ type: transport, url: fake.url, headers: {} });
    await client.initialize("fixture", AbortSignal.timeout(5_000));
    // without an answer the server holds the result until this deadline
    const result = await client.request("tools/call", { name: "ask_first", arguments: {} }, AbortSignal.timeout(5_000));
    expect(result).toEqual({ content: [{ type: "text", text: "remote execution recorded" }] });
    expect(fake.replies).toEqual([{ jsonrpc: "2.0", id: "server-ask-1", error: { code: -32601, message: "Method not supported by this client" } }]);
  });

  it.each(["http", "sse"] as const)("include a ping, which gets its empty answer over %s", async (transport) => {
    fake = await startFakeHttpMcp({ transport, tools: [{ name: "ask_first", inputSchema: { type: "object" } }], askOnCall: "ping" });
    client = new RemoteMcpClient({ type: transport, url: fake.url, headers: {} });
    await client.initialize("fixture", AbortSignal.timeout(5_000));
    await client.request("tools/call", { name: "ask_first", arguments: {} }, AbortSignal.timeout(5_000));
    expect(fake.replies).toEqual([{ jsonrpc: "2.0", id: "server-ask-1", result: {} }]);
  });
});

describe("a server's JSON-RPC error", () => {
  it.each(["http", "sse"] as const)("keeps its code and words over %s, apart from transport failures", async (transport) => {
    fake = await startFakeHttpMcp({ transport, tools: [{ name: "report" }], callError: () => ({ code: -32602, message: "Missing required parameter 'campaignId'" }) });
    client = new RemoteMcpClient({ type: transport, url: fake.url, headers: {} });
    await client.initialize("fixture", AbortSignal.timeout(5_000));
    const failure = await client.request("tools/call", { name: "report", arguments: {} }, AbortSignal.timeout(5_000)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(McpRpcError);
    expect(failure).toMatchObject({ kind: "protocol", code: -32602, detail: "Missing required parameter 'campaignId'" });
  });
});

describe("which plain http requests go through HTTP_PROXY", () => {
  it("skips loopback and NO_PROXY hosts the way curl does", () => {
    const at = (url: string, list = "") => bypassesProxy(new URL(url), list);
    for (const url of ["http://localhost:3000/mcp", "http://127.0.0.1/mcp", "http://127.8.0.1/mcp", "http://[::1]:8080/mcp", "http://app.localhost/mcp"]) expect(at(url)).toBe(true);
    expect(at("http://mcp.corp.internal/mcp")).toBe(false);
    expect(at("http://mcp.corp.internal/mcp", "corp.internal")).toBe(true);
    expect(at("http://mcp.corp.internal/mcp", ".corp.internal")).toBe(true);
    expect(at("http://mcp.corp.internal/mcp", "*.corp.internal")).toBe(true);
    expect(at("http://mcp.corp.internal/mcp", "*")).toBe(true);
    expect(at("http://mcp.corp.internal/mcp", "other.internal, ,corp.internal:8080")).toBe(false);
    expect(at("http://mcp.corp.internal:8080/mcp", "corp.internal:8080")).toBe(true);
    expect(at("http://notcorp.internal/mcp", "corp.internal")).toBe(false);
    expect(at("http://[fd00::1]/mcp", "[fd00::1]")).toBe(true);
  });

  it("is only set up when an HTTP proxy is", () => {
    expect(plainHttpProxyFetch({})).toBeUndefined();
    expect(plainHttpProxyFetch({ HTTPS_PROXY: "http://proxy.example.test:3128" })).toBeUndefined();
    expect(plainHttpProxyFetch({ HTTP_PROXY: "proxy.example.test:3128" })).toBeTypeOf("function");
  });

  it("leaves https and exempt requests to fetch", async () => {
    const seen: string[] = [];
    const fallback = (async (input: string | URL | Request) => { seen.push(String(input)); return new Response("{}"); }) as typeof fetch;
    const viaProxy = plainHttpProxyFetch({ HTTP_PROXY: "http://127.0.0.1:9", NO_PROXY: "corp.internal" }, fallback)!;
    await viaProxy("https://mcp.example.test/mcp");
    await viaProxy("http://mcp.corp.internal/mcp");
    await viaProxy("http://127.0.0.1:4000/mcp");
    expect(seen).toEqual(["https://mcp.example.test/mcp", "http://mcp.corp.internal/mcp", "http://127.0.0.1:4000/mcp"]);
  });
});
