// A bot's page reading its bot's data and keeping state through its rpc route, against a real DuckDB database.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { APP_LIMITS } from "../../shared/app.ts";
import { createChatApps, type ChatApps } from "../chat-apps.ts";
import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { createDataEngine } from "../data/engine.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { Store } from "../store.ts";
import { AppStates } from "../app-state.ts";
import { pageRows } from "./bot-page-rpc.ts";
import { createChatAppRoutes, type ChatAppRouteDeps } from "./chat-apps.ts";
import { dispatchRoutes } from "./table.ts";

const sonnet: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const servers: Server[] = [];
const apps: ChatApps[] = [];
const root = mkdtempSync(join(tmpdir(), "omb-page-rpc-"));
const engine = createDataEngine({ botFolder: (botId) => join(root, "bots", botId), dataDir: join(root, "data") });

beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));
afterEach(async () => {
  for (const app of apps.splice(0)) app.close();
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});
afterAll(async () => { await engine.closeAll(); });

async function fixture(options: { dataOff?: boolean; paused?: () => boolean; threadVisible?: ChatAppRouteDeps["threadVisible"] } = {}) {
  const store = new Store(() => sonnet);
  const bot = store.createBot({ name: "Scout" });
  const other = store.createBot({ name: "Other" });
  const chatApps = createChatApps({ store, dataDir: DATA_DIR, sweeps: false, ...(options.paused ? { paused: options.paused } : {}) });
  apps.push(chatApps);
  const routes = [createChatAppRoutes({ store, apps: chatApps, data: engine, dataOff: () => options.dataOff === true,
    ...(options.threadVisible ? { threadVisible: options.threadVisible } : {}) })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    // A test names a paired person with x-session; otherwise the request is the owner's, on this computer.
    const person = req.headers["x-session"];
    const auth = (typeof person === "string"
      ? { kind: "session", session: { id: person, email: `${person}@example.com` }, via: "bearer", scopes: ["client"] }
      : { kind: "loopback", scopes: ["admin", "client"] }) as RequestAuth;
    try {
      if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, { from: "inline routes" });
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const db = await engine.forBot(bot.id);
  await db.run("CREATE OR REPLACE TABLE sales AS SELECT i AS id, ['north', 'south'][1 + i % 2] AS region, (i * 10)::BIGINT AS amount FROM range(1, 301) t(i)", { connection: "bot" });
  const show = (input: Record<string, unknown>, who = bot, threadId = bot.threadId) => {
    const result = chatApps.createAppCard({ bot: who, threadId, input: { tool: "show_html", html: "<p>Dash</p>", title: "Dash", ...input } });
    if (result instanceof Promise || !result.ok) throw new Error("not shown");
    return result.messageId;
  };
  const rpc = async (id: string, method: string, params?: unknown, who = bot, threadId = bot.threadId, session?: string) => {
    const response = await fetch(`${base}/api/bots/${who.id}/apps/${id}/rpc`, {
      method: "POST", headers: { "content-type": "application/json", ...(session ? { "x-session": session } : {}) }, body: JSON.stringify({ threadId, method, ...(params === undefined ? {} : { params }) }),
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  return { store, bot, other, chatApps, show, rpc };
}

describe("mausbot.data.query on the rpc route", () => {
  it("answers a page that declared data with its bot's rows, as objects with numbers", async () => {
    const { show, rpc } = await fixture();
    const id = show({ uses: ["data"] });
    const answer = await rpc(id, "mausbot/data/query", { sql: "SELECT region, sum(amount) AS total, count(*) AS n FROM sales WHERE id <= ? GROUP BY 1 ORDER BY 1", params: [4] });
    expect(answer).toEqual({ status: 200, body: {
      columns: [{ name: "region", type: "VARCHAR" }, { name: "total", type: "HUGEINT" }, { name: "n", type: "BIGINT" }],
      rows: [{ region: "north", total: 60, n: 2 }, { region: "south", total: 40, n: 2 }],
      truncated: false,
    } });
  });

  it("refuses writes, files and anything but one SELECT, and the table is unchanged", async () => {
    const { bot, show, rpc } = await fixture();
    const id = show({ uses: ["data"] });
    for (const sql of [
      "INSERT INTO sales VALUES (999, 'x', 1)", "UPDATE sales SET amount = 0", "DELETE FROM sales", "CREATE TABLE t AS SELECT 1", "DROP TABLE sales",
      `ATTACH '${join(root, "x.duckdb")}' AS x`, `COPY sales TO '${join(root, "out.csv")}'`, "INSTALL httpfs", "LOAD httpfs", "SELECT 1; DELETE FROM sales",
      "SELECT * FROM read_csv('/etc/hosts')",
    ]) {
      const answer = await rpc(id, "mausbot/data/query", { sql });
      expect(answer.status, sql).toBe(409);
      expect(answer.body.error.message, sql).toContain("A page runs one SELECT on its bot's own tables and views.");
    }
    expect(existsSync(join(root, "out.csv"))).toBe(false);
    const count = await (await engine.forBot(bot.id)).run("SELECT count(*) FROM sales", { connection: "bot" });
    expect(count.rows).toEqual([["300"]]);
  });

  it("truncates at the row and byte caps", async () => {
    const { show, rpc } = await fixture();
    const id = show({ uses: ["data"] });
    const many = await rpc(id, "mausbot/data/query", { sql: `SELECT range AS n FROM range(${APP_LIMITS.pageQueryRows + 10})` });
    expect(many.body.rows).toHaveLength(APP_LIMITS.pageQueryRows);
    expect(many.body.truncated).toBe(true);
    const wide = await rpc(id, "mausbot/data/query", { sql: "SELECT repeat('x', 1500) AS s FROM range(1000)" });
    expect(wide.body.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(wide.body.rows))).toBeLessThanOrEqual(APP_LIMITS.pageQueryBytes);
    expect(wide.body.rows.length).toBeGreaterThan(0);
  });

  it("is refused to a page that did not declare it, an MCP app, another bot or conversation, a room, and a bot with Data off", async () => {
    const { store, bot, other, show, rpc } = await fixture();
    const plain = show({});
    expect(await rpc(plain, "mausbot/data/query", { sql: "SELECT 1" })).toEqual({ status: 409, body: { error: { code: -32000, message: 'This page did not declare "data": show it with uses: ["data"] to read its bot\'s data.' } } });
    const id = show({ uses: ["data"] });
    expect((await rpc(id, "mausbot/data/query", { sql: "SELECT 1" }, other, other.threadId)).status).toBe(404);
    expect((await rpc(id, "mausbot/data/query", { sql: "SELECT 1" }, other, bot.threadId)).status).toBe(404);
    const second = store.createTask(bot.id)!;
    expect((await rpc(id, "mausbot/data/query", { sql: "SELECT 1" }, bot, second.threadId)).status).toBe(404);
    // Another bot's page reads its own database, never this bot's.
    const theirs = show({ uses: ["data"] }, other, other.threadId);
    expect((await rpc(theirs, "mausbot/data/query", { sql: "SELECT count(*) FROM sales" }, other, other.threadId)).status).toBe(409);
    const room = store.createGroup("Launch", [bot.id, other.id]);
    const inRoom = show({ uses: ["data"] }, bot, room.threadId);
    for (const method of ["mausbot/data/query", "mausbot/state/keys"]) {
      expect(await rpc(inRoom, method, { sql: "SELECT 1" }, bot, room.threadId))
        .toEqual({ status: 409, body: { error: { code: -32000, message: "In a room, a page cannot read its bot's data or keep state." } } });
    }
    let paused = true;
    const waiting = await fixture({ paused: () => paused });
    expect((await waiting.rpc(waiting.show({ uses: ["data"] }), "mausbot/data/query", { sql: "SELECT 1" })).status).toBe(503);
    paused = false;
    const off = await fixture({ dataOff: true });
    expect((await off.rpc(off.show({ uses: ["data"] }), "mausbot/data/query", { sql: "SELECT 1" })).body.error.message).toContain("Data is switched off");
  });

  it("is refused to a person who cannot see the conversation, for data and state alike; the owner still reads it", async () => {
    const visible = vi.fn((auth: RequestAuth) => auth.kind !== "session" || auth.session.id !== "outsider");
    const { show, rpc, bot } = await fixture({ threadVisible: visible });
    const id = show({ uses: ["data", "state"] });
    const calls: Array<[string, Record<string, unknown>]> = [
      ["mausbot/data/query", { sql: "SELECT count(*) AS n FROM sales" }], ["mausbot/state/get", { key: "a" }],
      ["mausbot/state/set", { key: "a", value: 1 }], ["mausbot/state/keys", {}],
    ];
    for (const [method, params] of calls) {
      expect(await rpc(id, method, params, bot, bot.threadId, "outsider"), method).toEqual({ status: 404, body: { error: "no such conversation" } });
    }
    expect((await rpc(id, "mausbot/state/keys")).body).toEqual({ keys: [] });
    expect((await rpc(id, "mausbot/data/query", { sql: "SELECT count(*) AS n FROM sales" })).body.rows).toEqual([{ n: 300 }]);
    expect((await rpc(id, "mausbot/state/get", { key: "a" }, bot, bot.threadId, "member")).status).toBe(200);
  });

  it("holds a page to the rpc rate", async () => {
    const { show, rpc } = await fixture();
    const id = show({ uses: ["state"] });
    for (let i = 0; i < APP_LIMITS.rpcPerMinute; i++) expect((await rpc(id, "mausbot/state/keys")).status).toBe(200);
    expect((await rpc(id, "mausbot/state/keys")).status).toBe(429);
  });
});

describe("mausbot.state on the rpc route", () => {
  it("keeps values for the page, across its versions, until it stops declaring state", async () => {
    const { show, rpc, chatApps, bot } = await fixture();
    const id = show({ uses: ["state"] });
    expect(await rpc(id, "mausbot/state/get", { key: "filter" })).toEqual({ status: 200, body: {} });
    expect(await rpc(id, "mausbot/state/set", { key: "filter", value: { region: "north" } })).toEqual({ status: 200, body: {} });
    expect(await rpc(id, "mausbot/state/get", { key: "filter" })).toEqual({ status: 200, body: { value: { region: "north" } } });
    expect(await rpc(id, "mausbot/state/keys")).toEqual({ status: 200, body: { keys: ["filter"] } });
    // A new version without `uses` keeps what the page declared, and its state.
    const replaced = chatApps.createAppCard({ bot, threadId: bot.threadId, input: { tool: "update_html", app_id: id, html: "<p>Dash 2</p>" } });
    expect(replaced).toMatchObject({ ok: true, messageId: id });
    expect(chatApps.declaredUses(bot.threadId, id)).toEqual(["state"]);
    expect((await rpc(id, "mausbot/state/get", { key: "filter" })).body).toEqual({ value: { region: "north" } });
    // Setting without a value removes the key.
    expect((await rpc(id, "mausbot/state/set", { key: "filter" })).status).toBe(200);
    expect((await rpc(id, "mausbot/state/keys")).body).toEqual({ keys: [] });
    chatApps.createAppCard({ bot, threadId: bot.threadId, input: { tool: "update_html", app_id: id, html: "<p>Dash 3</p>", uses: [] } });
    expect((await rpc(id, "mausbot/state/keys")).status).toBe(409);
  });

  it("holds the caps and waits while the workspace is paused", async () => {
    let paused = false;
    const { show, rpc } = await fixture({ paused: () => paused });
    const id = show({ uses: ["state"] });
    expect((await rpc(id, "mausbot/state/set", { key: "k".repeat(APP_LIMITS.pageStateKeyChars + 1), value: 1 })).status).toBe(400);
    expect((await rpc(id, "mausbot/state/set", { key: "big", value: "x".repeat(APP_LIMITS.pageStateValueBytes) })).status).toBe(413);
    paused = true;
    expect((await rpc(id, "mausbot/state/set", { key: "a", value: 1 })).status).toBe(503);
    expect((await rpc(id, "mausbot/state/get", { key: "a" })).status).toBe(200);
    paused = false;
    expect((await rpc(id, "mausbot/state/set", { key: "a", value: 1 })).status).toBe(200);
  });
});

describe("AppStates", () => {
  it("caps a page's keys and bytes, and the sweep removes the state of rows that are gone", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-app-state-"));
    const states = new AppStates(dir);
    for (let i = 0; i < APP_LIMITS.pageStateKeys; i++) expect(states.set("t1", "m1", `k${i}`, i).ok).toBe(true);
    expect(states.set("t1", "m1", "one-more", 1)).toMatchObject({ ok: false, status: 413 });
    expect(states.set("t1", "m1", "k0", "replaced").ok).toBe(true);
    const chunk = "x".repeat(APP_LIMITS.pageStateValueBytes - 10);
    const fill = new AppStates(mkdtempSync(join(tmpdir(), "omb-app-state-")));
    let refused = false;
    for (let i = 0; i < 10 && !refused; i++) refused = !fill.set("t", "m", `v${i}`, chunk).ok;
    expect(refused).toBe(true);
    expect(states.set("t2", "m2", "a", 1).ok).toBe(true);
    expect(states.set("../x", "m", "a", 1)).toMatchObject({ ok: false, status: 404 });
    expect(states.sweep((threadId) => threadId === "t1")).toBe(1);
    expect(states.keys("t2", "m2")).toEqual({ ok: true, value: [] });
    expect(states.keys("t1", "m1").ok && (states.keys("t1", "m1") as { value: string[] }).value.length).toBe(APP_LIMITS.pageStateKeys);
    expect(existsSync(join(dir, "t2"))).toBe(false);
  });

  it("goes with its conversation in the chat apps' sweep", async () => {
    const { store, bot, show, rpc, chatApps } = await fixture();
    const second = store.createTask(bot.id)!;
    const id = show({ uses: ["state"] }, bot, second.threadId);
    expect((await rpc(id, "mausbot/state/set", { key: "a", value: 1 }, bot, second.threadId)).status).toBe(200);
    chatApps.sweep();
    expect(chatApps.states.keys(second.threadId, id)).toEqual({ ok: true, value: ["a"] });
    store.deleteTask(bot.id, second.threadId);
    chatApps.sweep();
    expect(chatApps.states.keys(second.threadId, id)).toEqual({ ok: true, value: [] });
  });
});

describe("pageRows", () => {
  it("keeps every column of a repeated name, and numbers that do not fit as text", () => {
    expect(pageRows({ columns: [{ name: "a", type: "BIGINT" }, { name: "a", type: "DECIMAL(4,1)" }, { name: "b", type: "HUGEINT" }], rows: [["1", "2.5", "123456789012345678901"]] }))
      .toEqual({ columns: [{ name: "a", type: "BIGINT" }, { name: "a_2", type: "DECIMAL(4,1)" }, { name: "b", type: "HUGEINT" }], rows: [{ a: 1, a_2: 2.5, b: "123456789012345678901" }] });
  });
});
