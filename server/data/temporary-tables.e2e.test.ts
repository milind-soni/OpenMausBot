import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchVerificationServer, runControlOmb } from "../../scripts/control-omb.ts";
import type { DataPage } from "../../shared/data-surface.ts";

const key = "data-temporary-tables-fixture";
let fixture: Awaited<ReturnType<typeof launchVerificationServer>>;
let next = 0;

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, status?: number): Promise<any> {
  const response = await fetch(fixture.info.url + path, {
    method, headers: { origin: fixture.info.url, "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  if (status !== undefined) expect(response.status, JSON.stringify(result)).toBe(status);
  else expect(response.ok, JSON.stringify(result)).toBe(true);
  return result;
}

beforeAll(async () => {
  fixture = await launchVerificationServer({ OMB_TEST_INTERNAL_CAPABILITY_KEY: key });
  expect(await runControlOmb(["doctor", "--url", fixture.info.url])).toMatchObject({ ok: true });
}, 60_000);
afterAll(async () => { await fixture?.close(); });

async function caller() {
  const { bot } = await api("POST", "/api/bots", { name: `Temporary Data ${++next}` });
  const { token } = await api("POST", "/api/testing/internal-capability", { botId: bot.id, threadId: bot.threadId, kind: "data" }, { "x-openmausbot-test-capability": key });
  return {
    botId: bot.id as string,
    call: async (name: string, args: Record<string, unknown>) => (await api("POST", "/api/internal/data/mcp", {
      method: "tools/call", params: { name, arguments: args },
    }, { authorization: `Bearer ${token}` })).result,
    page: (body: object, status?: number): Promise<DataPage> => api("POST", `/api/bots/${bot.id}/data/page`, { offset: 0, limit: 10, ...body }, {}, status),
  };
}

async function temporary(kind = "TABLE") {
  const h = await caller();
  const created = await h.call("data_sql", { sql: `CREATE TEMP ${kind} totals AS SELECT * FROM (VALUES (5), (9)) t(amount)` });
  const read = await h.call("data_sql", { sql: "SELECT amount FROM totals ORDER BY amount" });
  expect(read.structuredContent.rows).toEqual([[5], [9]]);
  return { ...h, created };
}

it.each(["TABLE", "VIEW"])("reports the temporary relation that CREATE TEMP %s actually created", async (kind) => {
  const { created } = await temporary(kind);
  expect(created.isError, JSON.stringify(created)).not.toBe(true);
  expect(created.structuredContent).toMatchObject({ table: "totals", rowCount: 2, columns: [{ name: "amount", type: "INTEGER" }] });
});

it("describes a temporary table on the same connection as its SQL", async () => {
  const h = await temporary();
  const result = await h.call("data_describe", { target: "totals" });
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  expect(result.structuredContent).toMatchObject({ rowCount: 2, columns: [{ name: "amount", min: "5", max: "9", approxUnique: 2 }] });
});

it("materializes a temporary source into a card that the panel can page", async () => {
  const h = await temporary();
  const result = await h.call("data_show", { table: "totals", kind: "table" });
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  expect((await h.page({ cardId: result.structuredContent.id })).rows.map(([amount]) => amount).sort()).toEqual([5, 9]);
});

it("exports a temporary table's actual rows", async () => {
  const h = await temporary();
  const path = join(fixture.info.dataDir, "workspaces", h.botId, "totals.csv");
  const result = await h.call("data_export", { table: "totals", format: "csv", path });
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  expect(result.structuredContent.rowCount).toBe(2);
  const [header, ...rows] = readFileSync(result.structuredContent.path, "utf8").trim().split(/\r?\n/);
  expect(header).toBe("amount");
  expect(rows.sort()).toEqual(["5", "9"]);
});

it("keeps a temporary source private to the bot connection until it is materialized", async () => {
  const h = await temporary();
  expect(await h.page({ table: "totals" }, 404)).toMatchObject({ error: { code: "table_not_found" } });
  const another = await caller();
  expect(await another.call("data_describe", { target: "totals" })).toMatchObject({ isError: true, structuredContent: { code: "table_not_found" } });
});

it("preserves DuckDB's temporary-table shadowing without changing the panel's persistent table", async () => {
  const h = await caller();
  expect((await h.call("data_sql", { sql: "CREATE TABLE totals AS SELECT 1 AS amount" })).isError).not.toBe(true);
  const created = await h.call("data_sql", { sql: "CREATE TEMP TABLE totals AS SELECT 42 AS amount, 'temporary' AS origin" });
  expect(created.isError, JSON.stringify(created)).not.toBe(true);
  expect(created.structuredContent.columns.map((column: { name: string }) => column.name)).toEqual(["amount", "origin"]);
  const shown = await h.call("data_show", { table: "totals", kind: "table" });
  expect(shown.isError, JSON.stringify(shown)).not.toBe(true);
  expect((await h.page({ cardId: shown.structuredContent.id })).rows).toEqual([[42, "temporary"]]);
  expect((await h.page({ table: "totals" })).rows).toEqual([[1]]);
});

it("honours an explicit catalog when a temporary table shadows a persistent table", async () => {
  const h = await caller();
  await h.call("data_sql", { sql: "CREATE TABLE totals AS SELECT 1 AS amount" });
  await h.call("data_sql", { sql: "CREATE TEMP TABLE totals AS SELECT 42 AS amount" });
  const current = await h.call("data_sql", { sql: "SELECT current_database() AS catalog" });
  const catalog = String(current.structuredContent.rows[0][0]).replaceAll('"', '""');
  const persistent = await h.call("data_show", { table: `"${catalog}".main.totals`, kind: "table" });
  expect(persistent.isError, JSON.stringify(persistent)).not.toBe(true);
  expect((await h.page({ cardId: persistent.structuredContent.id })).rows).toEqual([[1]]);
  const temporary = await h.call("data_describe", { target: "temp.main.totals" });
  expect(temporary.structuredContent.columns[0]).toMatchObject({ min: "42", max: "42" });
  expect(await h.page({ table: "temp.main.totals" }, 404)).toMatchObject({ error: { code: "table_not_found" } });
});

it("does not substitute a local table for a missing catalog", async () => {
  const h = await caller();
  await h.call("data_sql", { sql: "CREATE TABLE totals AS SELECT 1 AS amount" });
  const wrong = await h.call("data_show", { table: "other_catalog.main.totals", kind: "table" });
  expect(wrong).toMatchObject({ isError: true, structuredContent: { code: "table_not_found" } });
  expect(await h.page({ table: "other_catalog.main.totals" }, 404)).toMatchObject({ error: { code: "table_not_found" } });
  expect((await h.page({ table: "totals" })).rows).toEqual([[1]]);
});
