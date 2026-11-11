// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getFunctionName } from "convex/server";
import { afterAll, expect, test, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { GET, POST } from "../app/api/mcp/route";
import { integrationDb } from "./githubConnection";

// The MCP endpoint end to end over the real SDK transports, with Convex replaced by a recorder.
const calls: { name: string; args: Record<string, unknown> }[] = [];
const access = vi.hoisted(() => ({ write: true }));
vi.mock("./localRealtime", async importOriginal => ({
  ...await importOriginal<typeof import("./localRealtime")>(),
  limitLocalAction: () => {},
  getConvexClient: () => ({
    query: async (ref: unknown, args: Record<string, unknown>) => {
      const name = getFunctionName(ref as never);
      calls.push({ name, args });
      if (name === "connectors:verify") return { write: access.write, teamId: "team" };
      return JSON.stringify({ called: name });
    },
    mutation: async (ref: unknown, args: Record<string, unknown>) => {
      const name = getFunctionName(ref as never);
      calls.push({ name, args });
      return JSON.stringify({ called: name, title: args.title });
    },
  }),
}));

const directory = mkdtempSync(path.join(tmpdir(), "origin-mcp-route-"));
process.env.ORIGIN_LOCAL_DATA_DIR = directory;
process.env.ORIGIN_PUBLIC_URL = "http://origin.test";
afterAll(() => { integrationDb().close(); rmSync(directory, { recursive: true, force: true }); });

const token = `origin_pat_${"ab".repeat(32)}`;
const url = new URL("http://origin.test/api/mcp");
const exchanges: { method: string; version: string | null; status: number }[] = [];
const fetchRoute = async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init);
  const body = await request.clone().text();
  const response = request.method === "POST" ? await POST(request) : request.method === "GET" ? await GET(request) : new Response(null, { status: 405 });
  exchanges.push({ method: (() => { try { return JSON.parse(body).method ?? "batch"; } catch { return request.method; } })(), version: request.headers.get("mcp-protocol-version"), status: response.status });
  return response;
};
async function connect(versionNegotiation?: ConstructorParameters<typeof Client>[1] extends infer O ? O extends { versionNegotiation?: infer V } ? V : never : never) {
  const client = new Client({ name: "origin-test", version: "1.0.0" }, versionNegotiation ? { versionNegotiation } : {});
  await client.connect(new StreamableHTTPClientTransport(url, { fetch: fetchRoute, requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
const textOf = (result: unknown) => JSON.parse(((result as { content: { text: string }[] }).content[0]).text);

test("a 2026-07-28 client discovers the server and calls tools without a 400 or an initialize handshake", async () => {
  exchanges.length = 0; calls.length = 0;
  const client = await connect({ mode: "auto" });
  expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
  const tools = await client.listTools();
  expect(tools.tools.map(tool => tool.name)).toEqual(["get_workspace", "list_projects", "list_issues", "get_issue", "get_inbox", "list_members", "create_issue", "update_issue", "move_issue", "add_comment"]);
  expect(textOf(await client.callTool({ name: "create_issue", arguments: { project: "Web", title: "From a modern client" } }))).toEqual({ called: "mcp:createIssue", title: "From a modern client" });
  expect(calls.at(-1)).toEqual({ name: "mcp:createIssue", args: { token, project: "Web", title: "From a modern client" } });
  expect(exchanges[0]).toMatchObject({ method: "server/discover", status: 200 });
  expect(exchanges.every(exchange => exchange.status < 400)).toBe(true);
  expect(exchanges.some(exchange => exchange.method === "initialize")).toBe(false);
  await client.close();
});

test("2025-era clients keep the initialize handshake, JSON responses and batches", async () => {
  exchanges.length = 0;
  const client = await connect();
  expect(client.getNegotiatedProtocolVersion()).toBe("2025-11-25");
  expect(textOf(await client.callTool({ name: "get_inbox", arguments: {} }))).toEqual({ called: "mcp:inbox" });
  expect(exchanges.map(exchange => exchange.method)).toEqual(expect.arrayContaining(["initialize", "notifications/initialized", "tools/call"]));
  await client.close();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  for (const protocolVersion of ["2025-06-18", "2025-03-26", "2024-11-05"]) {
    const response = await POST(new Request(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion, capabilities: {}, clientInfo: { name: "old", version: "1" } } }) }));
    expect(response.headers.get("content-type")).toContain("application/json");
    expect((await response.json()).result.protocolVersion).toBe(protocolVersion);
  }
  const batch = await POST(new Request(url, { method: "POST", headers: { ...headers, "MCP-Protocol-Version": "2025-06-18" }, body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/list" }, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_workspace", arguments: {} } }]) }));
  const answers = await batch.json() as { id: number; result: { tools?: unknown[] } }[];
  expect(answers.map(answer => answer.id).sort()).toEqual([1, 2]);
  expect(batch.headers.get("cache-control")).toBe("no-store");
});

test("read-only tokens see only read tools in both eras; bad bearers never reach the server", async () => {
  access.write = false;
  try {
    for (const negotiation of [{ mode: "auto" as const }, undefined]) {
      const client = await connect(negotiation);
      expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain("create_issue");
      await client.close();
    }
  } finally { access.write = true; }
  const unauthenticated = await POST(new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
  expect(unauthenticated.status).toBe(401);
  expect(unauthenticated.headers.get("www-authenticate")).toContain("resource_metadata=");
  expect((await GET(new Request(url, { headers: { Authorization: `Bearer ${token}` } }))).status).toBe(405);
});
