// The Data tab's routes through the route table over a real HTTP server
// with a fake engine: the sheet, the person's SQL becoming a card on the
// panel's connection, cancel interrupting that connection, card edits,
// paging, the explorer's stats, export under an allowed folder, images, the
// error envelope and its statuses, and PASS for every other path.
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { dispatchRoutes } from "../routes/table.ts";
import { FakeDataDatabase } from "../testing/fake-data-database.ts";
import { createDataRoutes, dataErrorStatus, type DataRouteDeps } from "./routes.ts";
import { createDataEngine } from "./engine.ts";
import { DataSheetRegistry } from "./sheet.ts";
import { DataFailure } from "./types.ts";

const servers: Server[] = [];
const dirs: string[] = [];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function serve(overrides: Partial<DataRouteDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-data-routes-"));
  dirs.push(dir);
  const database = new FakeDataDatabase("bot-1");
  database.tables.set("orders", { columns: [{ name: "id", type: "INTEGER" }, { name: "total", type: "DOUBLE" }], rows: [[1, 9.5], [2, 3.25], [3, 7]] });
  const frames: unknown[] = [];
  const sheets = new DataSheetRegistry({ broadcast: (frame) => frames.push(frame), dropResult: (_bot, name) => database.dropResult(name), dir: (botId) => join(dir, "bots", botId) });
  const routes = [createDataRoutes({
    bot: (id) => (id === "bot-1" ? { id, cwd: join(dir, "work") } : undefined),
    engine: { unavailable: () => null, forBot: async () => database },
    sheets,
    compileChart: (spec, _columns, from) => ({ sql: `SELECT ${spec.x} AS x, count(*) AS y FROM ${from} GROUP BY ALL`, vegaLite: { mark: spec.type }, reduction: { method: "group" } }),
    validateVegaLite: async (spec) => spec as Record<string, unknown>,
    renderer: { svg: async (_s, rows) => `<svg>${rows.length}</svg>`, png: async (_s, rows, _c, options) => Buffer.from(`png ${rows.length} ${options.theme} ${options.width ?? "-"} ${options.scale ?? "-"}`) },
    exportRoots: (bot) => [bot.cwd ?? dir],
    ...overrides,
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: { kind: "loopback", scopes: ["admin"] } as never, json, readBody });
      if (!handled) json(res, 404, { from: "inline routes" });
    } catch (error) {
      json(res, 500, { error: String(error) });
    }
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const type = response.headers.get("content-type") ?? "";
    return { status: response.status, type, body: type.startsWith("image/") ? Buffer.from(await response.arrayBuffer()) : await response.json() as any };
  };
  return { call, database, sheets, frames, dir, base };
}

describe("the Data routes", () => {
  it("passes on other paths and answers the sheet with the loaded tables", async () => {
    const { call } = await serve();
    expect((await call("GET", "/api/bots/bot-1/memory")).body).toEqual({ from: "inline routes" });
    expect((await call("GET", "/api/bots/bot-1/browser/live")).body).toEqual({ from: "inline routes" });
    const sheet = await call("GET", "/api/bots/bot-1/data");
    expect(sheet.status).toBe(200);
    expect(sheet.body.sheet).toMatchObject({ version: 1, botId: "bot-1", cards: [], sources: [] });
    expect(sheet.body.tables).toEqual([{ name: "orders", rowCount: 3, columns: [{ name: "id", type: "INTEGER" }, { name: "total", type: "DOUBLE" }] }]);
    expect((await call("GET", "/api/bots/nobody/data")).status).toBe(404);
    expect((await call("GET", "/api/bots/bot-1/data/nothing")).status).toBe(400);
  });

  it("answers 503 engine_unavailable before touching anything when DuckDB cannot run", async () => {
    const { call, database } = await serve({ engine: { unavailable: () => "the DuckDB binding did not load", forBot: async () => { throw new Error("never"); } } });
    const reply = await call("GET", "/api/bots/bot-1/data");
    expect(reply.status).toBe(503);
    expect(reply.body).toEqual({ error: { code: "engine_unavailable", message: "the DuckDB binding did not load" } });
    expect(database.calls).toEqual([]);
  });

  it("turns the person's SQL into a card on the panel's connection, then edits, pages and deletes it", async () => {
    const { call, database, sheets, frames } = await serve();
    database.next = { columns: [{ name: "id", type: "INTEGER" }], rows: [[1], [2]], rowCount: 2 };
    const run = await call("POST", "/api/bots/bot-1/data/run", { sql: "SELECT id FROM orders", title: "Ids" });
    expect(run.status).toBe(200);
    expect(run.body.card).toMatchObject({ id: "c_1", by: "person", status: "ready", title: "Ids", result: "c_1", rowCount: 2 });
    expect(run.body.result).toMatchObject({ id: "c_1", rowCount: 2 });
    expect(database.calls.filter((entry) => entry.method === "materialise")).toEqual([expect.objectContaining({ connection: "panel", name: "c_1" })]);
    expect(frames.length).toBeGreaterThan(0);
    const page = await call("POST", "/api/bots/bot-1/data/page", { cardId: "c_1", offset: 0, limit: 10 });
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ rowCount: 2, offset: 0, rows: [[1], [2]] });
    expect(database.calls.at(-1)).toMatchObject({ method: "page", target: 'omb_results."c_1"' });

    const chart = await call("POST", "/api/bots/bot-1/data/run", { sql: "SELECT * FROM orders", chart: { type: "bar", x: "id" }, cardId: "c_1" });
    expect(chart.status).toBe(200);
    expect(chart.body.card).toMatchObject({ id: "c_1", kind: "chart", vegaLite: { mark: "bar" }, title: "Ids" });
    expect(sheets.for("bot-1").cards()).toHaveLength(1);

    const patched = await call("PATCH", "/api/bots/bot-1/data/cards/c_1", { title: "Orders by id", pinned: true });
    expect(patched.body.card).toMatchObject({ title: "Orders by id", pinned: true });
    expect((await call("PATCH", "/api/bots/bot-1/data/cards/c_1", { sql: "nope" })).status).toBe(400);

    const tablePage = await call("POST", "/api/bots/bot-1/data/page", { table: "orders", offset: 1, limit: 1 });
    expect(tablePage.body.rows).toEqual([[2, 3.25]]);
    expect((await call("POST", "/api/bots/bot-1/data/page", { table: "orders", cardId: "c_1", offset: 0, limit: 1 })).status).toBe(400);
    expect((await call("POST", "/api/bots/bot-1/data/page", { table: "orders", offset: 0, limit: 5000 })).status).toBe(400);
    expect((await call("POST", "/api/bots/bot-1/data/page", { cardId: "c_8", offset: 0, limit: 5 })).status).toBe(404);

    expect((await call("DELETE", "/api/bots/bot-1/data/cards/c_1")).body).toEqual({ ok: true });
    expect(database.calls.at(-1)).toMatchObject({ method: "dropResult", name: chart.body.card.result });
    expect((await call("DELETE", "/api/bots/bot-1/data/cards/c_1")).status).toBe(404);
  });

  it("pages column-filtered results through real DuckDB and rejects stale column names even with no text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-data-column-filter-"));
    dirs.push(dir);
    const engine = createDataEngine({ dataDir: dir, botFolder: (id) => join(dir, id) });
    try {
      const { call } = await serve({ engine });
      const created = await call("POST", "/api/bots/bot-1/data/run", { sql: "SELECT range::INTEGER AS id, CASE WHEN range % 2 = 0 THEN 'needle' ELSE 'other' END AS label, CASE WHEN range % 2 = 1 THEN 'needle' ELSE 'other' END AS notes FROM range(30)" });
      expect(created.status).toBe(200);
      const query = { cardId: created.body.card.id, offset: 1, limit: 2, filter: "needle", sort: { column: "id", direction: "desc" } };
      const scoped = await call("POST", "/api/bots/bot-1/data/page", { ...query, filterColumn: "label" });
      expect(scoped).toMatchObject({ status: 200, body: { rowCount: 15, offset: 1, rows: [[26, "needle", "other"], [24, "needle", "other"]] } });
      expect((await call("POST", "/api/bots/bot-1/data/page", query)).body.rowCount).toBe(30);
      for (const filter of [undefined, ""]) {
        expect(await call("POST", "/api/bots/bot-1/data/page", { ...query, filter, filterColumn: "removed" })).toMatchObject({ status: 400, body: { error: { code: "invalid_input", message: expect.stringContaining("removed") } } });
      }
      for (const filterColumn of ["", "x".repeat(301), 1, null]) {
        expect((await call("POST", "/api/bots/bot-1/data/page", { ...query, filterColumn })).status).toBe(400);
      }
      expect((await call("POST", "/api/bots/bot-1/data/page", { ...query, filter: "", filterColumn: "label" })).body.rowCount).toBe(30);
    } finally {
      await engine.closeAll();
    }
  });

  it("maps refused SQL, missing tables and engine errors to the error envelope", async () => {
    const { call, database } = await serve();
    const refused = await call("POST", "/api/bots/bot-1/data/run", { sql: "DELETE FROM orders" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: "write_refused", sql: "DELETE FROM orders" });
    const missing = await call("GET", "/api/bots/bot-1/data/tables/nope/stats");
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatchObject({ code: "table_not_found", candidates: ["orders"] });
    database.failNext = new DataFailure({ code: "sql_error", message: "Binder Error: no", line: 1 });
    const failed = await call("POST", "/api/bots/bot-1/data/run", { sql: "SELECT nope FROM orders" });
    expect(failed.status).toBe(422);
    expect(failed.body.error).toMatchObject({ code: "sql_error", line: 1 });
    expect((await call("POST", "/api/bots/bot-1/data/run", { sql: "" })).status).toBe(400);
    expect((await call("POST", "/api/bots/bot-1/data/run", "not json")).status).toBe(400);
    expect(dataErrorStatus("output_too_large")).toBe(422);
    expect(dataErrorStatus("timeout")).toBe(503);
  });

  it("marks an orphan running card cancelled without interrupting another card's query", async () => {
    const { call, database, sheets } = await serve();
    const sheet = sheets.for("bot-1");
    const running = await sheet.addCard({ kind: "table", title: "Slow", sql: "SELECT 1", by: "person" });
    const cancelled = await call("POST", "/api/bots/bot-1/data/cancel", { cardId: running.id });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.card).toMatchObject({ id: running.id, status: "failed", error: { code: "cancelled" } });
    expect(database.interrupted).toEqual([]);
    expect((await call("POST", "/api/bots/bot-1/data/cancel", { cardId: "c_77" })).status).toBe(404);
  });

  it("keeps simple and raw chart specs when live SQL edits omit them, with no intermediate frames", async () => {
    const { call, sheets, frames } = await serve();
    for (const spec of [{ chart: { type: "bar", x: "id" } }, { vegaLite: { mark: "point" } }]) {
      const created = await call("POST", "/api/bots/bot-1/data/run", { sql: "SELECT * FROM orders", ...spec });
      expect(created.status).toBe(200);
      const id = created.body.card.id;
      const before = frames.length;
      const edited = await call("POST", "/api/bots/bot-1/data/run", { cardId: id, sql: "SELECT * FROM orders LIMIT 2", live: true });
      expect(edited.status).toBe(200);
      expect(edited.body.card).toMatchObject({ id, kind: "chart", status: "ready", ...spec });
      expect(frames.length - before).toBe(1);
      const good = sheets.for("bot-1").card(id);
      expect((await call("POST", "/api/bots/bot-1/data/run", { cardId: id, sql: "", live: true })).status).toBe(400);
      expect(sheets.for("bot-1").card(id)).toBe(good);
      expect(frames.length - before).toBe(1);
    }
    expect((await call("POST", "/api/bots/bot-1/data/run", { sql: "SELECT 1", live: true })).status).toBe(400);
  });

  it("cancels superseded native queries and disconnected edits while preserving the last committed result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-data-live-native-"));
    dirs.push(dir);
    const engine = createDataEngine({ dataDir: dir, botFolder: (id) => join(dir, id) });
    try {
      const database = await engine.forBot("bot-1");
      const { call, sheets, base } = await serve({ engine });
      const initial = await call("POST", "/api/bots/bot-1/data/run", { sql: "SELECT 1 AS n" });
      expect(initial.status).toBe(200);
      let started = deferred();
      const materialise = database.materialise.bind(database);
      database.materialise = (sql, name, options) => {
        if (sql.includes("100000000")) started.resolve();
        return materialise(sql, name, options);
      };
      const slowSql = "SELECT count(*) AS n FROM range(100000000) x, range(100000000) y";
      const older = call("POST", "/api/bots/bot-1/data/run", { cardId: "c_1", sql: slowSql, live: true });
      await started.promise;
      const latest = await call("POST", "/api/bots/bot-1/data/run", { cardId: "c_1", sql: "SELECT 9 AS n", live: true });
      expect(latest.status).toBe(200);
      expect((await older).body.error.code).toBe("cancelled");
      expect((await call("POST", "/api/bots/bot-1/data/page", { cardId: "c_1", offset: 0, limit: 10 })).body.rows).toEqual([[9]]);
      const good = sheets.for("bot-1").card("c_1");

      started = deferred();
      const abort = new AbortController();
      const disconnected = fetch(`${base}/api/bots/bot-1/data/run`, {
        method: "POST", headers: { "content-type": "application/json" }, signal: abort.signal,
        body: JSON.stringify({ cardId: "c_1", sql: slowSql, live: true }),
      }).catch((error: Error) => error);
      await started.promise;
      abort.abort();
      expect(await disconnected).toBeInstanceOf(Error);
      // The queued health query can finish only after the abandoned native query is interrupted.
      await database.run("SELECT 1", { connection: "panel", timeoutMs: 1_000 });
      expect(sheets.for("bot-1").card("c_1")).toBe(good);
      await expect.poll(async () => (await database.run("SELECT table_name FROM information_schema.tables WHERE table_schema = 'omb_results'", { connection: "bot" })).rows).toEqual([[good!.result]]);
    } finally {
      await engine.closeAll();
    }
  }, 15_000);

  it("serves the explorer's stats and histograms by resolved table", async () => {
    const { call, database } = await serve();
    const stats = await call("GET", "/api/bots/bot-1/data/tables/ORDERS/stats");
    expect(stats.status).toBe(200);
    expect(stats.body).toMatchObject({ rowCount: 3 });
    expect(database.calls.at(-1)).toMatchObject({ method: "stats", target: '"orders"' });
    const histogram = await call("GET", "/api/bots/bot-1/data/tables/orders/histogram?column=total&bins=10");
    expect(histogram.status).toBe(200);
    expect(histogram.body.bins).toHaveLength(2);
    expect((await call("GET", "/api/bots/bot-1/data/tables/orders/histogram")).status).toBe(400);
  });

  it("exports under the bot's working folder and renders a chart card's image", async () => {
    const { call, dir } = await serve();
    await call("POST", "/api/bots/bot-1/data/run", { sql: "SELECT id FROM orders", title: "Ids" });
    const exported = await call("POST", "/api/bots/bot-1/data/export", { cardId: "c_1", format: "csv" });
    expect(exported.status).toBe(200);
    expect(exported.body.path).toBe(join(dir, "work", "ids.csv"));
    expect(existsSync(exported.body.path)).toBe(true);
    expect((await call("POST", "/api/bots/bot-1/data/export", { cardId: "c_1", format: "csv", path: "/tmp/x.csv" })).status).toBe(400);
    const notChart = await call("GET", "/api/bots/bot-1/data/cards/c_1/image");
    expect(notChart.status).toBe(400);

    await call("POST", "/api/bots/bot-1/data/run", { sql: "SELECT * FROM orders", chart: { type: "pie", x: "id" }, title: "Share" });
    const png = await call("GET", "/api/bots/bot-1/data/cards/c_2/image?theme=dark&width=640&scale=2");
    expect(png.status).toBe(200);
    expect(png.type).toBe("image/png");
    expect((png.body as Buffer).toString()).toBe("png 3 dark 640 2");
    const svg = await call("GET", "/api/bots/bot-1/data/cards/c_2/image?format=svg");
    expect(svg.type).toContain("image/svg+xml");
    expect((svg.body as Buffer).toString()).toBe("<svg>3</svg>");
    expect((await call("GET", "/api/bots/bot-1/data/cards/c_9/image")).status).toBe(404);
  });
});
