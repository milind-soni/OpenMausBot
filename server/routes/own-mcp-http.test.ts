import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openHarnessGate } from "../bot-box/harness-gate.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createOwnMcpHttpRoutes, ownMcpHttpRoutes } from "./own-mcp-http.ts";
import type { RouteHandler } from "./table.ts";
import { AGENTS_ENV_HEADER, OWN_MCP_HTTP_PATH } from "./own-mcp-http-path.ts";
import { TOOL_LIMIT_ENV, TOOL_LIMIT_HEADER } from "../tool-count-limit.ts";

/** This server's own internal endpoints, as the stdio proxies reach them: the turn's capability is checked there. */
const internalCalls: Array<{ path: string; authorization?: string; body?: unknown }> = [];
let server: Server;
let base: string;
/** The route under test; a test may swap in one with shorter timings or smaller limits. */
let routes: RouteHandler = ownMcpHttpRoutes;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith(OWN_MCP_HTTP_PATH)) {
      await routes({ req, res, url, path: url.pathname, method: req.method ?? "GET", auth: {} as RequestAuth, json, readBody });
      return;
    }
    const body = req.method === "POST" ? await readBody(req) : undefined;
    internalCalls.push({ path: `${url.pathname}${url.search}`, authorization: req.headers.authorization, body });
    if (req.headers.authorization !== "Bearer turn-capability") return json(res, 401, { error: "unauthorized" });
    if (url.pathname === "/api/internal/browser/mcp") {
      const call = body as { method: string; params?: { name?: string } };
      return json(res, 200, { result: call.method === "tools/list"
        ? { tools: [{ name: "agent_browser_open", inputSchema: { type: "object" } }] }
        : call.params?.name === "slow" || call.params?.name === "slower"
          ? await new Promise((resolve) => setTimeout(() => resolve({ content: [{ type: "text", text: `ran ${call.params?.name}` }] }), call.params?.name === "slow" ? 600 : 2_500))
          : call.params?.name === "large" ? { content: [{ type: "text", text: "x".repeat(2_000) }] }
            : { content: [{ type: "text", text: `ran ${call.params?.name}` }] } });
    }
    if (url.pathname === "/api/internal/agents") return json(res, 200, { bots: [{ id: "w1", name: "W1", model: "m" }] });
    return json(res, 404, { error: "no such endpoint" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const post = (kind: string, body: unknown, headers: Record<string, string> = { authorization: "Bearer turn-capability" }) =>
  fetch(`${base}${OWN_MCP_HTTP_PATH}${kind}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });
/** A JSON body, or the replies of a server-sent event stream (one, or all of a batch's in id order). */
async function read(response: { headers: { get(name: string): string | null }; text(): Promise<string> }): Promise<unknown> {
  const text = await response.text();
  if (!response.headers.get("content-type")?.startsWith("text/event-stream")) return JSON.parse(text);
  const events = text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)) as { id: number });
  return events.length === 1 ? events[0] : events.sort((a, b) => a.id - b.id);
}
const agentsHeaders = (settings: Record<string, string>) => ({ authorization: "Bearer turn-capability",
  [AGENTS_ENV_HEADER]: Buffer.from(JSON.stringify(settings)).toString("base64url") });

describe("OpenMausBot's own MCP servers over HTTP", () => {
  it("answers a browser session the way its stdio proxy does, with the turn's capability on every call", async () => {
    const init = await post("browser", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
    expect(init.status).toBe(200);
    expect(await init.json()).toMatchObject({ id: 1, result: { protocolVersion: "2025-06-18", serverInfo: { name: "openmausbot-browser" } } });
    const notice = await post("browser", { jsonrpc: "2.0", method: "notifications/initialized" });
    expect([notice.status, await notice.text()]).toEqual([202, ""]);
    expect(await (await post("browser", { jsonrpc: "2.0", id: 2, method: "tools/list" })).json())
      .toEqual({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "agent_browser_open", inputSchema: { type: "object" } }] } });
    const batch = await read(await post("browser", [{ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "agent_browser_open", arguments: {} } },
      { jsonrpc: "2.0", id: 4, method: "ping" }]));
    expect(batch).toEqual([{ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "ran agent_browser_open" }] } }, { jsonrpc: "2.0", id: 4, result: {} }]);
    expect(internalCalls.filter((call) => call.path === "/api/internal/browser/mcp").every((call) => call.authorization === "Bearer turn-capability")).toBe(true);
  });

  it("refuses without a capability, passes a wrong one to the endpoint that refuses it, and offers no stream or unknown server", async () => {
    expect((await post("browser", { jsonrpc: "2.0", id: 1, method: "tools/list" }, {})).status).toBe(401);
    const wrong = await read(await post("browser", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "agent_browser_open" } },
      { authorization: "Bearer stolen" }));
    expect(wrong).toMatchObject({ id: 1, result: { isError: true } });
    expect((await fetch(`${base}${OWN_MCP_HTTP_PATH}browser`, { headers: { authorization: "Bearer turn-capability" } })).status).toBe(405);
    expect((await post("shell", { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(404);
  });

  it("serves the agents server with the bot's own settings, and calls the harness as that bot with the turn's capability", async () => {
    const list = async (settings: Record<string, string>) =>
      ((await (await post("agents", { jsonrpc: "2.0", id: 1, method: "tools/list" }, agentsHeaders(settings))).json()) as { result: { tools: Array<{ name: string }> } })
        .result.tools.map((tool) => tool.name);
    const worker = await list({ OMB_BOT_ID: "w2", OMB_THREAD_ID: "t2" });
    const chief = await list({ OMB_BOT_ID: "chief", OMB_THREAD_ID: "t1", OMB_CHIEF_OF_STAFF: "1" });
    expect(worker).toContain("coordinate_bots");
    expect(chief.length).toBeGreaterThan(worker.length);
    internalCalls.length = 0;
    const call = await read(await post("agents", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_bots", arguments: {} } },
      agentsHeaders({ OMB_BOT_ID: "chief", OMB_THREAD_ID: "t1", OMB_HARNESS_URL: "http://203.0.113.9:1" })));
    expect(call).toMatchObject({ id: 2, result: { content: [{ type: "text", text: expect.stringContaining("W1") }] } });
    expect(internalCalls).toEqual([
      expect.objectContaining({ path: "/api/internal/agents?self=chief", authorization: "Bearer turn-capability" }),
      expect.objectContaining({ path: "/api/internal/tool-timing", authorization: "Bearer turn-capability", body: expect.objectContaining({ name: "list_bots", ok: true }) }),
    ]);
  });

  it("keeps Claude's deferred catalog: the setting rides the agents server's settings header", async () => {
    const tools = async (settings: Record<string, string>) =>
      ((await (await post("agents", { jsonrpc: "2.0", id: 1, method: "tools/list" }, agentsHeaders(settings))).json()) as { result: { tools: Array<{ name: string; _meta?: Record<string, unknown> }> } }).result.tools;
    const deferred = (list: Array<{ _meta?: Record<string, unknown> }>) => list.filter((tool) => tool._meta?.["anthropic/alwaysLoad"] === false).length;
    expect(deferred(await tools({ OMB_BOT_ID: "w2", OMB_THREAD_ID: "t2" }))).toBe(0);
    expect(deferred(await tools({ OMB_BOT_ID: "w2", OMB_THREAD_ID: "t2", OMB_AGENTS_DEFER_TOOLS: "1" }))).toBeGreaterThan(0);
  });

  it("lists no more of a server's tools than the turn's tool limit allows", async () => {
    const limited = await (await post("browser", { jsonrpc: "2.0", id: 5, method: "tools/list" },
      { authorization: "Bearer turn-capability", [TOOL_LIMIT_HEADER]: "0" })).json();
    expect(limited).toEqual({ jsonrpc: "2.0", id: 5, result: { tools: [] } });
    const agents = async (settings: Record<string, string>) =>
      ((await (await post("agents", { jsonrpc: "2.0", id: 6, method: "tools/list" }, agentsHeaders(settings))).json()) as { result: { tools: Array<{ name: string }> } })
        .result.tools.map((tool) => tool.name);
    const whole = await agents({ OMB_BOT_ID: "w2", OMB_THREAD_ID: "t2" });
    expect(await agents({ OMB_BOT_ID: "w2", OMB_THREAD_ID: "t2", [TOOL_LIMIT_ENV]: "3" })).toEqual(whole.slice(0, 3));
  });
});

describe("a long tool call, and the stdio proxy's limits", () => {
  const capability = { "content-type": "application/json", authorization: "Bearer turn-capability" };
  const slow = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "slow", arguments: {} } };
  const swap = async <T>(route: RouteHandler, run: () => Promise<T>): Promise<T> => {
    routes = route;
    try { return await run(); } finally { routes = ownMcpHttpRoutes; }
  };

  it("streams headers at once and keeps the connection busy, so a client that gives up on silence still gets its answer", async () => {
    // An HTTP client that gives up after 300 ms without headers or bytes (undici checks about every half second), as
    // Node's fetch does after 300 s; the call takes 2.5 s.
    const impatient = new Agent({ headersTimeout: 300, bodyTimeout: 300 });
    const slower = { ...slow, params: { name: "slower", arguments: {} } };
    try {
      await swap(createOwnMcpHttpRoutes({ keepaliveMs: 100 }), async () => {
        const streamed = await undiciFetch(`${base}${OWN_MCP_HTTP_PATH}browser`, { method: "POST", dispatcher: impatient,
          headers: { ...capability, accept: "application/json, text/event-stream" }, body: JSON.stringify(slower) });
        expect(streamed.headers.get("content-type")).toBe("text/event-stream");
        const text = await streamed.text();
        expect(text).toContain(": keepalive");
        expect(await read({ headers: streamed.headers, text: async () => text })).toEqual({ jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: "ran slower" }] } });
        // Without server-sent events the answer is one JSON body, sent when the call ends: too late for this client.
        await expect(undiciFetch(`${base}${OWN_MCP_HTTP_PATH}browser`, { method: "POST", dispatcher: impatient,
          headers: { ...capability, accept: "application/json" }, body: JSON.stringify(slower) })).rejects.toMatchObject({ cause: { code: "UND_ERR_HEADERS_TIMEOUT" } });
      });
    } finally {
      await impatient.close();
    }
  });

  it("answers a quick list as JSON even to a client that takes events", async () => {
    const listed = await post("browser", { jsonrpc: "2.0", id: 8, method: "tools/list" });
    expect(listed.headers.get("content-type")).toBe("application/json");
  });

  it("holds each capability to 16 requests in flight per server, a batch's included, as its stdio proxy does", async () => {
    await swap(createOwnMcpHttpRoutes({ maxPending: 2 }), async () => {
      const batch = [7, 8, 9].map((id) => ({ ...slow, id }));
      const answered = await read(await post("browser", batch)) as Array<{ id: number; result: { isError?: boolean; content: Array<{ text: string }> } }>;
      expect(answered.map((reply) => [reply.id, reply.result.content[0]!.text])).toEqual([[7, "ran slow"], [8, "ran slow"], [9, "Too many pending browser requests."]]);
      // Another capability, another bot's turn, has its own.
      const first = post("browser", [{ ...slow, id: 1 }, { ...slow, id: 2 }]);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const other = await read(await post("browser", { ...slow, id: 3 }, { authorization: "Bearer another-turn" })) as { result: { content: Array<{ text: string }> } };
      expect(other.result.content[0]!.text).not.toMatch(/Too many pending/);
      const same = await read(await post("browser", { ...slow, id: 4 })) as { result: { content: Array<{ text: string }> } };
      expect(same.result.content[0]!.text).toBe("Too many pending browser requests.");
      await read(await first);
      const after = await read(await post("browser", { ...slow, id: 5 })) as { result: { content: Array<{ text: string }> } };
      expect(after.result.content[0]!.text).toBe("ran slow");
    });
  });

  it("cuts an answer over the stdio proxy's output cap to a failure the bot can read, over a whole batch", async () => {
    await swap(createOwnMcpHttpRoutes({ maxOutputBytes: 3_000 }), async () => {
      const large = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "large", arguments: {} } });
      const one = await read(await post("browser", large(1))) as { result: { isError?: boolean } };
      expect(one.result.isError).toBeUndefined();
      const two = await read(await post("browser", [large(1), large(2)])) as Array<{ id: number; result: { isError?: boolean; content: Array<{ text: string }> } }>;
      expect(two.filter((reply) => reply.result.isError === true).map((reply) => reply.result.content[0]!.text)).toEqual(["The browser answer exceeded the size limit."]);
    });
  });
});

// The box's harness gate listens on a unix socket, which Windows refuses at a file path; the box runs only on Linux.
describe.skipIf(process.platform === "win32")("an engine in the bot box", () => {
  it("reaches these servers through the box's harness gate, as its stdio proxies reach the routes behind them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-own-mcp-gate-"));
    const gate = await openHarnessGate({ socketPath: join(dir, "harness.sock"), port: Number(new URL(base).port) });
    const call = (path: string, body: unknown) => new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = request({ socketPath: gate.socketPath, path, method: "POST", headers: { "content-type": "application/json",
        accept: "application/json, text/event-stream", authorization: "Bearer turn-capability" } }, (res) => {
        let text = "";
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      });
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });
    try {
      const listed = await call(`${OWN_MCP_HTTP_PATH}browser`, { jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect(JSON.parse(listed.text)).toMatchObject({ id: 1, result: { tools: [{ name: "agent_browser_open" }] } });
      const called = await call(`${OWN_MCP_HTTP_PATH}browser`, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "agent_browser_open", arguments: {} } });
      expect(JSON.parse(called.text.split("\n").find((line) => line.startsWith("data: "))!.slice(6))).toEqual(
        { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "ran agent_browser_open" }] } });
      expect((await call("/api/bots", {})).status).toBe(403);
    } finally {
      await gate.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
