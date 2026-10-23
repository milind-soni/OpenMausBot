import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppPayload } from "../../shared/app.ts";
import { BOT_HTML_CSP } from "../../shared/app-frame/csp.ts";
import { CSP_META_PREFIX } from "../../shared/app-frame/document.ts";
import { createChatApps, type ChatApps } from "../chat-apps.ts";
import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { Store } from "../store.ts";
import { createChatAppRoutes, type ChatAppRouteDeps, type McpRpcRequest } from "./chat-apps.ts";
import { dispatchRoutes } from "./table.ts";

const sonnet: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const servers: Server[] = [];
const apps: ChatApps[] = [];

beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));
afterEach(async () => {
  for (const app of apps.splice(0)) app.close();
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function fixture(extra: Partial<ChatAppRouteDeps> = {}) {
  const store = new Store(() => sonnet);
  const bot = store.createBot({ name: "Scout" });
  const other = store.createBot({ name: "Other" });
  const chatApps = createChatApps({ store, dataDir: DATA_DIR, sweeps: false });
  apps.push(chatApps);
  const routes = [createChatAppRoutes({ store, apps: chatApps, ...extra })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const auth = { kind: "loopback", scopes: ["admin", "client"] } as RequestAuth;
      if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, { from: "inline routes" });
    } catch (error) {
      json(res, (error as { status?: number }).status ?? 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (path: string) => {
    const response = await fetch(`${base}${path}`);
    return { status: response.status, body: await response.json() as Record<string, any>, cache: response.headers.get("cache-control") };
  };
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const page = (threadId = bot.threadId) => {
    const result = chatApps.createAppCard({ bot, threadId, input: { tool: "show_html", html: "<p>Hello</p>", title: "Hello" } });
    if (result instanceof Promise || !result.ok) throw new Error("not shown");
    return result.messageId;
  };
  const mcpRow = (threadId = bot.threadId) => {
    const stored = chatApps.docs.put({ source: "mcp", html: "<p>view</p>", data: { tool: { name: "get-time" }, network: { connect: [], resources: [] } } });
    if (!stored.ok) throw new Error("not stored");
    const app: AppPayload = { v: 1, source: "mcp", title: "Get time", doc: stored.doc, rev: 0, bytes: 11, border: true, network: { connect: [], resources: [] }, mcp: { server: "basic", tool: "get-time", resourceUri: "ui://basic/view" } };
    return store.appendMessage(threadId, { role: "bot", kind: "app", text: "Basic · Get time", app }).id;
  };
  return { store, bot, other, chatApps, get, post, page, mcpRow };
}

describe("GET /api/threads/:threadId/messages/:messageId/app", () => {
  it("serves an app row's document, never cached", async () => {
    const { bot, get, page } = await fixture();
    const id = page();
    const answer = await get(`/api/threads/${bot.threadId}/messages/${id}/app`);
    expect(answer.status).toBe(200);
    expect(answer.cache).toBe("private, no-store");
    expect(answer.body).toMatchObject({ v: 1, messageId: id, rev: 0, csp: BOT_HTML_CSP });
    expect(String(answer.body.srcdoc).startsWith(`${CSP_META_PREFIX}${BOT_HTML_CSP}">`)).toBe(true);
    expect(answer.body).not.toHaveProperty("approval");
  });

  it("answers 404 for an unknown thread, another thread's row, a row that is not an app, and a missing document", async () => {
    const { store, bot, other, get, page } = await fixture();
    const id = page();
    const text = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "hi" }).id;
    expect((await get(`/api/threads/nope/messages/${id}/app`)).status).toBe(404);
    expect((await get(`/api/threads/${other.threadId}/messages/${id}/app`)).body).toEqual({ error: "no app on that message" });
    expect((await get(`/api/threads/${bot.threadId}/messages/${text}/app`)).status).toBe(404);
    const gone = store.appendMessage(bot.threadId, { role: "bot", kind: "app", text: "x", app: { v: 1, source: "html", title: "x", doc: "", rev: 0, bytes: 1, border: true, network: { connect: [], resources: [] }, blocked: "too-large" } }).id;
    expect(await get(`/api/threads/${bot.threadId}/messages/${gone}/app`)).toMatchObject({ status: 404, body: { error: "This app's page is not stored on this computer." } });
  });
});

describe("POST /api/bots/:botId/apps/:messageId/context", () => {
  it("keeps the app's context on its row", async () => {
    const { store, bot, post, page } = await fixture();
    const id = page();
    expect(await post(`/api/bots/${bot.id}/apps/${id}/context`, { threadId: bot.threadId, content: [{ type: "text", text: "Looking at March" }] })).toEqual({ status: 200, body: { ok: true } });
    expect(store.messagesFor(bot.threadId).find((message) => message.id === id)?.app?.context).toMatchObject({ text: "Looking at March", delivered: false });
  });

  it("answers only for an app row of this bot and thread", async () => {
    const { store, bot, other, post, page } = await fixture();
    const id = page();
    const text = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "hi" }).id;
    const body = { threadId: bot.threadId, content: [] };
    expect(await post(`/api/bots/${bot.id}/apps/${id}/context`, { content: [] })).toMatchObject({ status: 400 });
    expect(await post(`/api/bots/nobody/apps/${id}/context`, body)).toMatchObject({ status: 404, body: { error: "no such bot" } });
    expect(await post(`/api/bots/${other.id}/apps/${id}/context`, body)).toMatchObject({ status: 404, body: { error: "no such conversation" } });
    expect(await post(`/api/bots/${other.id}/apps/${id}/context`, { threadId: other.threadId, content: [] })).toMatchObject({ status: 404 });
    expect(await post(`/api/bots/${bot.id}/apps/${text}/context`, body)).toMatchObject({ status: 404 });
    expect(await post(`/api/bots/${bot.id}/apps/${id}/context`, { threadId: bot.threadId, content: "words" })).toMatchObject({ status: 400 });
  });

  it("refuses a Cloud guest's change to a conversation it did not start", async () => {
    const { bot, post, page } = await fixture({ threadRefusal: () => "On this Cloud you can only change conversations you started." });
    const id = page();
    expect(await post(`/api/bots/${bot.id}/apps/${id}/context`, { threadId: bot.threadId, content: [] }))
      .toEqual({ status: 403, body: { error: "On this Cloud you can only change conversations you started." } });
  });

  it("holds an app to 120 updates a minute", async () => {
    const { bot, post, page } = await fixture();
    const id = page();
    const statuses: number[] = [];
    for (let index = 0; index < 121; index += 1) statuses.push((await post(`/api/bots/${bot.id}/apps/${id}/context`, { threadId: bot.threadId, content: [{ type: "text", text: String(index) }] })).status);
    expect(statuses.slice(0, 120).every((status) => status === 200)).toBe(true);
    expect(statuses[120]).toBe(429);
  });
});

describe("POST /api/bots/:botId/apps/:messageId/rpc", () => {
  it("refuses a bot page: it has no server (404)", async () => {
    const mcpRpc = vi.fn();
    const { bot, post, page } = await fixture({ mcpRpc });
    const id = page();
    expect(await post(`/api/bots/${bot.id}/apps/${id}/rpc`, { threadId: bot.threadId, method: "tools/list" })).toEqual({ status: 404, body: { error: "That app has no server to call." } });
    expect(mcpRpc).not.toHaveBeenCalled();
  });

  it("answers 404 for an MCP row until the MCP side is wired", async () => {
    const { bot, post, mcpRow } = await fixture();
    const id = mcpRow();
    expect(await post(`/api/bots/${bot.id}/apps/${id}/rpc`, { threadId: bot.threadId, method: "tools/call", params: { name: "get-time" } }))
      .toEqual({ status: 404, body: { error: "This app cannot reach its server on this computer yet." } });
  });

  it("hands a well-formed call on an MCP row of this bot and thread to mcpRpc, with the row", async () => {
    const mcpRpc = vi.fn(async (request: McpRpcRequest) => ({ status: 200, body: { content: [{ type: "text", text: `ran ${String(request.params.name)}` }] } }));
    const { bot, other, post, mcpRow } = await fixture({ mcpRpc });
    const id = mcpRow();
    expect(await post(`/api/bots/${bot.id}/apps/${id}/rpc`, { threadId: bot.threadId, method: "tools/call", params: { name: "get-time", arguments: {} } }))
      .toEqual({ status: 200, body: { content: [{ type: "text", text: "ran get-time" }] } });
    expect(mcpRpc).toHaveBeenCalledTimes(1);
    const request = mcpRpc.mock.calls[0]![0];
    expect(request).toMatchObject({ threadId: bot.threadId, method: "tools/call", params: { name: "get-time", arguments: {} }, bot: { id: bot.id } });
    expect(request.row).toMatchObject({ id, kind: "app", app: { source: "mcp" } });
    // Malformed, or another bot's or thread's row: never reaches it.
    expect(await post(`/api/bots/${bot.id}/apps/${id}/rpc`, { threadId: bot.threadId, method: "prompts/list" })).toMatchObject({ status: 400 });
    expect(await post(`/api/bots/${bot.id}/apps/${id}/rpc`, { threadId: bot.threadId, method: "tools/call", params: "x" })).toMatchObject({ status: 400 });
    expect(await post(`/api/bots/${other.id}/apps/${id}/rpc`, { threadId: other.threadId, method: "tools/list" })).toMatchObject({ status: 404 });
    expect(await post(`/api/bots/${other.id}/apps/${id}/rpc`, { threadId: bot.threadId, method: "tools/list" })).toMatchObject({ status: 404 });
    // An older client's `confirmed` is not passed on: nothing the page or the client says lifts the approval level.
    expect(await post(`/api/bots/${bot.id}/apps/${id}/rpc`, { threadId: bot.threadId, method: "tools/list", confirmed: true })).toMatchObject({ status: 200 });
    expect(mcpRpc.mock.calls.at(-1)![0]).not.toHaveProperty("confirmed");
    expect(mcpRpc).toHaveBeenCalledTimes(2);
  });

  it("leaves every other path to the next handler", async () => {
    const { bot, get, post, page } = await fixture();
    const id = page();
    expect((await post(`/api/bots/${bot.id}/apps/${id}/delete`, { threadId: bot.threadId })).body).toEqual({ from: "inline routes" });
    expect((await get(`/api/bots/${bot.id}/apps/${id}/rpc`)).body).toEqual({ from: "inline routes" });
  });
});
