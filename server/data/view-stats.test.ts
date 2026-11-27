import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import type { DataColumnStats, DataPage } from "../../shared/data-surface.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { dispatchRoutes } from "../routes/table.ts";
import { compileChart } from "./chart-compiler.ts";
import { createDataEngine } from "./engine.ts";
import { chartRenderer } from "./render.ts";
import { createDataRoutes } from "./routes.ts";
import { dataRpc } from "./rpc.ts";
import { DataSheetStore } from "./sheet.ts";
import type { DataEngine } from "./types.ts";
import { validateVegaLite } from "./vega-lite-validator.ts";

const roots: string[] = [];
const engines: DataEngine[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  await Promise.all(engines.splice(0).map((engine) => engine.closeAll()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});

async function serve() {
  const root = mkdtempSync(join(tmpdir(), "omb-view-stats-"));
  roots.push(root);
  const source = join(root, "counts.csv");
  writeFileSync(source, "id,amount\n1,1\n2,\n");
  const engine = createDataEngine({ botFolder: (id) => join(root, id), dataDir: join(root, "data") });
  engines.push(engine);
  const database = await engine.forBot("stats-bot");
  const sheet = new DataSheetStore({ botId: "stats-bot", dir: join(root, "sheet"), dropResult: (name) => database.dropResult(name) });
  const services = { compileChart, validateVegaLite, renderer: chartRenderer };
  const sql = async (sql: string) => {
    const result = await dataRpc({ method: "tools/call", params: { name: "data_sql", arguments: { sql } } }, {
      database, sheet, ...services, exportRoots: () => [root], signal: new AbortController().signal, assertActive() {},
    });
    expect(result).not.toHaveProperty("isError", true);
  };
  await sql(`CREATE VIEW live_counts AS SELECT * FROM read_csv('${source.replaceAll("'", "''")}')`);
  const routes = createDataRoutes({
    engine, sheets: { for: () => sheet }, ...services, exportRoots: () => [root],
    bot: (id) => id === "stats-bot" ? { id, cwd: root } : null,
  });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as RequestAuth;
    if (!await dispatchRoutes([routes], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/bots/stats-bot/data`;
  const api = async <T>(path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json() as T;
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return result;
  };
  return {
    sql,
    replace: (csv = "id,amount\n1,5\n2,9\n") => writeFileSync(source, csv),
    stats: (table: string) => api<DataColumnStats>(`/tables/${encodeURIComponent(table)}/stats`),
    page: (table: string) => api<DataPage>("/page", { table, offset: 0, limit: 10, sort: { column: "id", direction: "asc" } }),
  };
}

const amount = (stats: DataColumnStats) => stats.columns.find((column) => column.name === "amount");

it("refreshes the inspector when a CSV-backed view changes without changing its row count", async () => {
  const h = await serve();
  const before = await h.stats("live_counts");
  expect(before.rowCount).toBe(2);
  expect(amount(before)).toMatchObject({ min: "1", max: "1", nullPct: 50, approxUnique: 1 });
  h.replace();
  const after = await h.stats("live_counts");
  const page = await h.page("live_counts");
  expect(page.rows.map((row) => row.map(Number))).toEqual([[1, 5], [2, 9]]);
  expect(after.rowCount).toBe(2);
  expect(amount(after)).toMatchObject({ min: "5", max: "9", nullPct: 0, approxUnique: 2 });
});

it("refreshes a view that reads the changing file through another view", async () => {
  const h = await serve();
  await h.sql("CREATE VIEW doubled_counts AS SELECT id, amount * 2 AS amount FROM live_counts");
  expect(amount(await h.stats("doubled_counts"))).toMatchObject({ min: "2", max: "2", nullPct: 50 });
  h.replace();
  expect(amount(await h.stats("doubled_counts"))).toMatchObject({ min: "10", max: "18", nullPct: 0 });
  expect((await h.page("doubled_counts")).rows.map((row) => row.map(Number))).toEqual([[1, 10], [2, 18]]);
});

it("still refreshes a view when its row count changes", async () => {
  const h = await serve();
  expect((await h.stats("live_counts")).rowCount).toBe(2);
  h.replace("id,amount\n1,5\n2,9\n3,12\n");
  const after = await h.stats("live_counts");
  expect(after.rowCount).toBe(3);
  expect(amount(after)).toMatchObject({ min: "5", max: "12", nullPct: 0 });
});

it("keeps a physical table's snapshot when only its former source file changes", async () => {
  const h = await serve();
  await h.sql("CREATE TABLE frozen_counts AS SELECT * FROM live_counts");
  const before = await h.stats("frozen_counts");
  h.replace();
  expect(await h.stats("frozen_counts")).toEqual(before);
  expect((await h.page("frozen_counts")).rows).toEqual([["1", "1"], ["2", null]]);
});
