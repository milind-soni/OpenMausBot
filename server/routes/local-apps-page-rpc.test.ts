// A saved app whose page declared data and state, opened from its own document route and calling the page rpc route
// exactly as the app view does (its bot, the source conversation and the page's message), against a real DuckDB database.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { createChatApps, type ChatApps } from "../chat-apps.ts";
import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { createDataEngine } from "../data/engine.ts";
import { json, readBody } from "../harness/http.ts";
import { createLocalApps, type LocalApps } from "../local-apps/service.ts";
import { withLocalAppDocs } from "../local-apps/store.ts";
import type { RequestAuth } from "../request-auth.ts";
import { Store } from "../store.ts";
import { createChatAppRoutes } from "./chat-apps.ts";
import { createLocalAppsRoutes } from "./local-apps.ts";
import { dispatchRoutes } from "./table.ts";

const sonnet: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const servers: Server[] = [];
const closers: Array<{ close(): void }> = [];
const root = mkdtempSync(join(tmpdir(), "omb-local-app-rpc-"));
const engine = createDataEngine({ botFolder: (botId) => join(root, "bots", botId), dataDir: join(root, "data") });

beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));
afterEach(async () => {
  for (const one of closers.splice(0)) one.close();
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});
afterAll(async () => { await engine.closeAll(); });

async function fixture() {
  const store = new Store(() => sonnet);
  const bot = store.createBot({ name: "Scout" });
  const chatApps: ChatApps = createChatApps({ store, dataDir: DATA_DIR, sweeps: false, references: withLocalAppDocs(DATA_DIR) });
  const localApps: LocalApps = createLocalApps({ chat: store, docs: chatApps.docs, dataDir: DATA_DIR });
  closers.push(chatApps, localApps);
  const everything = { everything: true, thread: () => true };
  const routes = [
    createLocalAppsRoutes({ apps: localApps, store, visibleFor: () => everything }),
    createChatAppRoutes({ store, apps: chatApps, data: engine, dataOff: () => false, threadVisible: () => true }),
  ];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin", "client"] } as RequestAuth;
    try {
      if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, { from: "inline routes" });
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const db = await engine.forBot(bot.id);
  await db.run("CREATE OR REPLACE TABLE sales AS SELECT i AS id, ['north', 'south'][1 + i % 2] AS region, (i * 10)::BIGINT AS amount FROM range(1, 11) t(i)", { connection: "bot" });
  const thread = store.createTask(bot.id, "Dashboards")!.threadId!;
  const show = (input: Record<string, unknown>) => {
    const result = chatApps.createAppCard({ bot, threadId: thread, input: { tool: "show_html", html: "<p>Dash</p>", title: "Sales board", ...input } });
    if (result instanceof Promise || !result.ok) throw new Error("not shown");
    return result.messageId;
  };
  /** The app view's bridge call: its app's bot, source conversation and the document's message. */
  const rpc = (app: { botId: string; threadId: string }, messageId: string, method: string, params?: unknown) =>
    call("POST", `/api/bots/${app.botId}/apps/${messageId}/rpc`, { threadId: app.threadId, method, ...(params === undefined ? {} : { params }) });
  const save = async (messageId: string) => {
    const saved = await call("POST", "/api/local-apps", { botId: bot.id, threadId: thread, messageId });
    if (saved.status !== 201) throw new Error(JSON.stringify(saved.body));
    return saved.body.app as { id: string; botId: string; threadId: string; manifest: { name: string; uses?: string[] } };
  };
  return { store, bot, thread, chatApps, call, show, rpc, save };
}

describe("a saved app that reads its bot's data and keeps state", () => {
  it("gets data and state in its own document, and its queries and state reach the page rpc route", async () => {
    const { call, show, rpc, save } = await fixture();
    const messageId = show({ uses: ["data", "state"] });
    const app = await save(messageId);
    expect(app.manifest).toEqual({ name: "Sales board", uses: ["data", "state"] });
    const doc = (await call("GET", `/api/local-apps/${app.id}/app`)).body;
    expect(doc).toMatchObject({ messageId, can: { data: true, state: true, message: true } });
    const rows = await rpc(app, doc.messageId, "mausbot/data/query", { sql: "SELECT region, sum(amount) AS total FROM sales GROUP BY 1 ORDER BY 1" });
    expect(rows).toMatchObject({ status: 200, body: { rows: [{ region: "north", total: 300 }, { region: "south", total: 250 }], truncated: false } });
    expect(await rpc(app, doc.messageId, "mausbot/state/set", { key: "filter", value: { region: "north" } })).toEqual({ status: 200, body: {} });
    expect(await rpc(app, doc.messageId, "mausbot/state/get", { key: "filter" })).toEqual({ status: 200, body: { value: { region: "north" } } });
  });

  it("keeps the declared abilities when the bot replaces the page without saying, and a page without them gets none", async () => {
    const { call, show, chatApps, bot, thread, save } = await fixture();
    const messageId = show({ uses: ["data"] });
    const app = await save(messageId);
    chatApps.createAppCard({ bot, threadId: thread, input: { tool: "update_html", app_id: messageId, html: "<p>Dash 2</p>" } });
    const followed = (await call("GET", `/api/local-apps/${app.id}`)).body.app;
    expect(followed).toMatchObject({ rev: 1, manifest: { uses: ["data"] } });
    expect((await call("GET", `/api/local-apps/${app.id}/app`)).body.can).toMatchObject({ data: true });
    const plain = await save(show({ title: "Plain" }));
    expect(plain.manifest.uses).toBeUndefined();
    const can = (await call("GET", `/api/local-apps/${plain.id}/app`)).body.can;
    expect(can.data ?? false).toBe(false);
    expect(can.state ?? false).toBe(false);
  });

  it("can no longer read live data once its chat is deleted: the route refuses, the app still opens", async () => {
    const { call, show, rpc, store, bot, thread, save } = await fixture();
    const messageId = show({ uses: ["data", "state"] });
    const app = await save(messageId);
    store.deleteTask(bot.id, thread);
    expect((await call("GET", `/api/local-apps/${app.id}`)).body.app.chat).toBe(false);
    expect((await call("GET", `/api/local-apps/${app.id}/app`)).status).toBe(200);
    expect((await rpc(app, messageId, "mausbot/data/query", { sql: "SELECT 1 AS one" })).status).toBe(404);
    expect((await rpc(app, messageId, "mausbot/state/keys")).status).toBe(404);
  });

  it("carries the connector tools a page declared into its document and manifest", async () => {
    const { call, show, save } = await fixture();
    const messageId = show({ uses: ["data", "gmail:GMAIL_FETCH_EMAILS", "gmail:GMAIL_TRASH_MESSAGE"] });
    const app = await save(messageId);
    expect(app.manifest.uses).toEqual(["data", "gmail:GMAIL_FETCH_EMAILS", "gmail:GMAIL_TRASH_MESSAGE"]);
    const { can } = (await call("GET", `/api/local-apps/${app.id}/app`)).body;
    expect(can).toMatchObject({ data: true, connectors: [{ connector: "gmail", tools: ["GMAIL_FETCH_EMAILS", "GMAIL_TRASH_MESSAGE"] }] });
    expect(can.state ?? false).toBe(false);
  });
});

