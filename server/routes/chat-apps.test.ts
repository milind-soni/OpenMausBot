import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ROOM_VIEW_ONLY, type AppPayload } from "../../shared/app.ts";
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
      if (chatApps.serveFile(req, res, url.pathname, req.method ?? "GET")) return;
      // A test names a paired person with x-session; otherwise the request is the owner's, on this computer.
      const person = req.headers["x-session"];
      const auth = (typeof person === "string"
        ? { kind: "session", session: { id: person, email: `${person}@example.com` }, via: "bearer", scopes: ["client"] }
        : { kind: "loopback", scopes: ["admin", "client"] }) as RequestAuth;
      if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, { from: "inline routes" });
    } catch (error) {
      json(res, (error as { status?: number }).status ?? 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (path: string, session?: string) => {
    const response = await fetch(`${base}${path}`, session ? { headers: { "x-session": session } } : {});
    return { status: response.status, body: await response.json() as Record<string, any>, cache: response.headers.get("cache-control") };
  };
  const file = async (url: string) => {
    const response = await fetch(url);
    return { status: response.status, text: await response.text() };
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
  const room = () => store.createGroup("Launch", [bot.id, other.id]);
  /** A folder page with a data file beside its index.html, shown by `bot` in `threadId`. */
  const folderPage = async (threadId: string) => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "omb-room-page-")));
    mkdirSync(join(base, "dash"));
    writeFileSync(join(base, "dash", "index.html"), "<h1>Dash</h1>");
    writeFileSync(join(base, "dash", "data.csv"), "a\n1");
    const result = await chatApps.createAppCard({ bot, threadId, input: { tool: "show_html", path: "dash", title: "Dash" }, folders: async () => ({ roots: [base], vmWorkspace: null }) });
    if (!result.ok) throw new Error(result.error);
    return result.messageId;
  };
  return { store, bot, other, chatApps, get, post, page, mcpRow, room, folderPage, file, base };
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
    expect(await get(`/api/threads/${bot.threadId}/messages/${gone}/app`)).toMatchObject({ status: 404, body: { error: "This app's page is not stored on this computer.", errorKey: "serverError.page.notStored" } });
  });
});

describe("GET /api/threads/:threadId/messages/:messageId/app/download", () => {
  it("hands a bot's page over as an opaque download, never as a page to render", async () => {
    const { bot, page, base } = await fixture();
    const response = await fetch(`${base}/api/threads/${bot.threadId}/messages/${page()}/app/download`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="Hello\.html"/);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("sandbox");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).toContain("<p>Hello</p>");
  });

  it("refuses a folder page with files beside it, an MCP app, another conversation's row and a bad version", async () => {
    const { bot, other, get, page, mcpRow, folderPage } = await fixture();
    const id = page();
    const path = (threadId: string, messageId: string) => `/api/threads/${threadId}/messages/${messageId}/app/download`;
    expect((await get(path(bot.threadId, await folderPage(bot.threadId)))).body).toMatchObject({ errorKey: "serverError.page.downloadHasFiles" });
    expect((await get(path(bot.threadId, mcpRow()))).status).toBe(409);
    expect((await get(path(other.threadId, id))).status).toBe(404);
    expect((await get(`${path(bot.threadId, id)}?rev=x`)).status).toBe(400);
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

describe("an app shown in a room", () => {
  it("is served to whoever can see the room, view-only, and to nobody else", async () => {
    let roomVisible = true;
    const { bot, get, page, room } = await fixture({ threadVisible: (auth, threadId) => auth.kind !== "session" || (threadId === group.threadId ? roomVisible : true) });
    const group = room();
    const id = page(group.threadId);
    const seen = await get(`/api/threads/${group.threadId}/messages/${id}/app`, "ann");
    expect(seen.status).toBe(200);
    expect(seen.body).toMatchObject({ room: true, can: { message: false, modelContext: false, serverTools: false, serverResources: false, openLinks: true } });
    expect(String(seen.body.srcdoc)).toContain("var room = true;");
    roomVisible = false;
    expect(await get(`/api/threads/${group.threadId}/messages/${id}/app`, "ann")).toMatchObject({ status: 404, body: { error: "no such conversation" } });
    expect((await get(`/api/threads/${group.threadId}/messages/${id}/app`)).status).toBe(200);
    const own = await get(`/api/threads/${bot.threadId}/messages/${page()}/app`, "ann");
    expect(own.body).toMatchObject({ can: { message: true, modelContext: true } });
    expect(own.body).not.toHaveProperty("room");
  });

  it("loads a folder page's files only with the viewer's own token, and only while they can see the room", async () => {
    let annSees = true;
    const { get, room, folderPage, file, base } = await fixture({ threadVisible: (auth) => auth.kind !== "session" || auth.session.id !== "ann" || annSees });
    const group = room();
    const id = await folderPage(group.threadId);
    const folderOf = async (session: string) => {
      const answer = await get(`/api/threads/${group.threadId}/messages/${id}/app?origin=${encodeURIComponent(base)}`, session);
      expect(answer.status).toBe(200);
      return /<base href="([^"]+)">/.exec(String(answer.body.srcdoc))![1]!;
    };
    const ann = await folderOf("ann");
    const bob = await folderOf("bob");
    expect(ann).not.toBe(bob);
    expect(await file(`${ann}data.csv`)).toEqual({ status: 200, text: "a\n1" });
    annSees = false;
    expect(await file(`${ann}data.csv`)).toEqual({ status: 404, text: "Not found." });
    expect(await file(`${bob}data.csv`)).toEqual({ status: 200, text: "a\n1" });
  });

  it("stops a page's files once the page is gone from its conversation", async () => {
    const { store, get, room, folderPage, file, base } = await fixture();
    const group = room();
    const id = await folderPage(group.threadId);
    const answer = await get(`/api/threads/${group.threadId}/messages/${id}/app?origin=${encodeURIComponent(base)}`);
    const folder = /<base href="([^"]+)">/.exec(String(answer.body.srcdoc))![1]!;
    expect((await file(`${folder}data.csv`)).status).toBe(200);
    const row = store.messagesFor(group.threadId).find((message) => message.id === id)!;
    store.patchMessage(group.threadId, id, { app: { ...row.app!, doc: "", history: [] } });
    expect(await file(`${folder}data.csv`)).toEqual({ status: 404, text: "Not found." });
  });

  it("refuses its context and its server calls on the server, whatever the page or the client sends", async () => {
    const mcpRpc = vi.fn();
    const { store, bot, post, page, mcpRow, room } = await fixture({ mcpRpc });
    const group = room();
    const id = page(group.threadId);
    const app = mcpRow(group.threadId);
    expect(await post(`/api/bots/${bot.id}/apps/${id}/context`, { threadId: group.threadId, content: [{ type: "text", text: "Ann is looking at March" }] }))
      .toEqual({ status: 409, body: { error: ROOM_VIEW_ONLY } });
    expect(await post(`/api/bots/${bot.id}/apps/${app}/rpc`, { threadId: group.threadId, method: "tools/call", params: { name: "get-time", arguments: {} } }))
      .toEqual({ status: 409, body: { error: ROOM_VIEW_ONLY } });
    expect(mcpRpc).not.toHaveBeenCalled();
    expect(store.messagesFor(group.threadId).find((message) => message.id === id)?.app).not.toHaveProperty("context");
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
