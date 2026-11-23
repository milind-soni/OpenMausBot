import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { chartRenderer, compileChart, validateVegaLite } from "./deps.ts";
import { createDataEngine, quoteIdentifier } from "./engine.ts";
import { DataSheetStore } from "./sheet.ts";
import { loadData, runDataTool, type DataContext } from "./tools.ts";

const root = mkdtempSync(join(tmpdir(), "omb-load-name-collisions-"));
const folder = join(root, "mixed");
const engine = createDataEngine({ botFolder: (id) => join(root, "bots", id), dataDir: join(root, "data") });
const connection = "bot" as const;

beforeAll(async () => {
  mkdirSync(folder);
  writeFileSync(join(folder, "first.csv"), "origin,value\ncsv,1\n");
  writeFileSync(join(folder, "second.json"), JSON.stringify([{ origin: "json", value: 2 }]));
  const writer = await engine.forBot("writer");
  await writer.run(`COPY (SELECT 'parquet' AS origin, 3 AS value) TO '${join(folder, "third.parquet").replaceAll("'", "''")}' (FORMAT PARQUET)`, { connection });
});

afterAll(async () => {
  await engine.closeAll();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function context(botId: string): Promise<DataContext> {
  return {
    database: await engine.forBot(botId),
    sheet: new DataSheetStore({ botId, dir: join(root, "sheets", botId) }),
    renderer: chartRenderer,
    compileChart,
    validateVegaLite,
    exportRoots: () => [root],
    signal: new AbortController().signal,
    connection,
    by: "bot",
  };
}

async function writeOrigin(ctx: DataContext, origin: string, value: number): Promise<void> {
  if (origin === "csv") {
    writeFileSync(join(folder, "first.csv"), `origin,value\ncsv,${value}\n`);
    return;
  }
  if (origin === "json") {
    writeFileSync(join(folder, "second.json"), JSON.stringify([{ origin: "json", value }]));
    return;
  }
  const file = join(folder, "third.parquet");
  await rm(file, { force: true });
  await ctx.database.run(`COPY (SELECT 'parquet' AS origin, ${value} AS value) TO '${file.replaceAll("'", "''")}' (FORMAT PARQUET)`, { connection });
}

async function expectAllSources(ctx: DataContext, tables: Array<{ name: string }>) {
  expect(new Set(tables.map((table) => table.name)).size).toBe(3);
  const rows = [];
  for (const table of tables) {
    expect(table.name.length).toBeLessThanOrEqual(63);
    const result = await ctx.database.run(`SELECT origin, value FROM ${quoteIdentifier(table.name)}`, { connection });
    rows.push(...result.rows.map(([origin, value]) => [origin, Number(value)]));
  }
  expect(rows).toEqual(expect.arrayContaining([["csv", 1], ["json", 2], ["parquet", 3]]));
  expect(rows).toHaveLength(3);
}

describe("distinct table names within one import", () => {
  it.each([62, 63])("keeps every file family when a %i-character prefix truncates their names", async (length) => {
    const ctx = await context(`long-${length}`);
    const result = await loadData(ctx, { source: folder, name: "t".repeat(length) });
    await expectAllSources(ctx, result.tables);
    expect(await ctx.database.listTables()).toHaveLength(3);
    expect(ctx.sheet.sheet().sources).toHaveLength(3);

    const stem = result.tables[0]!.name;
    const suffix = (n: number) => `${stem.slice(0, 62 - String(n).length)}_${n}`;
    expect(result.tables.map((table) => table.name)).toEqual([stem, suffix(2), suffix(3)]);

    const placed = suffix(2);
    const before = await ctx.database.run(`SELECT origin, value FROM ${quoteIdentifier(placed)}`, { connection });
    const origin = String(before.rows[0]?.[0]);
    expect(["csv", "json", "parquet"]).toContain(origin);
    const updated = 9;
    await writeOrigin(ctx, origin, updated);
    try {
      const reloaded = await loadData(ctx, { source: folder, name: "t".repeat(length), replace: true });
      expect(reloaded.tables.map((table) => table.name)).toEqual([stem, suffix(2), suffix(3)]);
      expect(await ctx.database.listTables()).toHaveLength(3);
      const fresh = await ctx.database.run(`SELECT origin, value FROM ${quoteIdentifier(placed)}`, { connection });
      expect(fresh.rows.map(([name, value]) => [name, Number(value)])).toEqual([[origin, updated]]);
    } finally {
      await writeOrigin(ctx, origin, origin === "csv" ? 1 : origin === "json" ? 2 : 3);
    }
  });

  it("keeps a pre-existing long name when replacement is disabled", async () => {
    const ctx = await context("no-replacement");
    const name = "t".repeat(63);
    await ctx.database.run(`CREATE TABLE ${quoteIdentifier(name)} AS SELECT 'existing' AS origin, 99 AS value`, { connection });
    const result = await loadData(ctx, { source: folder, name, replace: false });
    await expectAllSources(ctx, result.tables);
    expect(await ctx.database.listTables()).toHaveLength(4);
    expect((await ctx.database.run(`SELECT origin, value FROM ${quoteIdentifier(name)}`, { connection })).rows).toEqual([["existing", 99]]);
  });

  it("still replaces a requested existing table on a single-file import", async () => {
    const ctx = await context("single-file");
    await ctx.database.run("CREATE TABLE imported AS SELECT 'existing' AS origin, 99 AS value", { connection });
    const result = await loadData(ctx, { source: join(folder, "first.csv"), name: "imported" });
    expect(result.tables.map((table) => table.name)).toEqual(["imported"]);
    expect(await ctx.database.listTables()).toHaveLength(1);
    const rows = await ctx.database.run("SELECT origin, value FROM imported", { connection });
    expect(rows.rows.map(([origin, value]) => [origin, Number(value)])).toEqual([["csv", 1]]);
  });

  const invalidView = [
    "CREATE TABLE sales AS SELECT 1 AS id, 10 AS amount",
    "CREATE VIEW sales_report AS SELECT id, amount FROM sales",
    "CREATE TABLE other_data AS SELECT 5 AS id",
    "CREATE OR REPLACE TABLE sales AS SELECT 2 AS id, 20 AS total",
  ];

  async function unboundView(botId: string): Promise<DataContext> {
    const ctx = await context(botId);
    for (const sql of invalidView) {
      const result = await runDataTool(ctx, "data_sql", { sql });
      expect(result.isError, result.content[0]?.text).toBeUndefined();
    }
    return ctx;
  }

  it("loads an unrelated csv while a view is unbound", async () => {
    const ctx = await unboundView("unrelated-csv");
    const file = join(root, "customers.csv");
    writeFileSync(file, "id,name\n1,Alice\n");
    const loaded = await runDataTool(ctx, "data_load", { source: file });
    expect(loaded.isError, loaded.content[0]?.text).toBeUndefined();
    expect(loaded.structuredContent!.tables).toMatchObject([{ name: "customers", rowCount: 1 }]);
    expect((await ctx.database.run("SELECT * FROM customers", { connection })).rows).toEqual([["1", "Alice"]]);
    expect(ctx.sheet.sheet().sources.map((source) => source.name)).toContain("customers");
  });

  it.each([
    ["replace false", { replace: false }],
    ["replace omitted", {}],
  ] as const)("keeps the unbound view when an import asks for its name and %s", async (label, options) => {
    const ctx = await unboundView(`view-collision-${label.replaceAll(" ", "-")}`);
    const file = join(root, `sales-report-${label.replaceAll(" ", "-")}.csv`);
    writeFileSync(file, "id,name\n1,Alice\n");
    const loaded = await runDataTool(ctx, "data_load", { source: file, name: "sales_report", ...options });
    expect(loaded.isError, loaded.content[0]?.text).toBeUndefined();
    expect(loaded.structuredContent!.tables).toMatchObject([{ name: "sales_report_2" }]);
    expect((await ctx.database.run("SELECT * FROM sales_report_2", { connection })).rows).toEqual([["1", "Alice"]]);
    const view = (await ctx.database.listTables()).find((table) => table.name === "sales_report");
    expect(view?.rowCount).toBeNull();
    expect(view?.error).toMatchObject({ code: "sql_error" });
    expect(view?.error?.message).toContain("amount");
  });

  it("reloads a file an invalid view displaced into the same suffixed table", async () => {
    const ctx = await unboundView("view-reload-same-suffix");
    const file = join(root, "sales-report-reload.csv");
    writeFileSync(file, "id,name\n1,Alice\n");
    const loaded = await runDataTool(ctx, "data_load", { source: file, name: "sales_report" });
    expect(loaded.isError, loaded.content[0]?.text).toBeUndefined();
    expect(loaded.structuredContent!.tables).toMatchObject([{ name: "sales_report_2" }]);
    const before = (await ctx.database.listTables()).length;

    writeFileSync(file, "id,name\n2,Bob\n");
    const reloaded = await runDataTool(ctx, "data_load", { source: file, name: "sales_report", replace: true });
    expect(reloaded.isError, reloaded.content[0]?.text).toBeUndefined();
    expect(reloaded.structuredContent!.tables).toMatchObject([{ name: "sales_report_2", rowCount: 1 }]);
    expect((await ctx.database.run("SELECT * FROM sales_report_2", { connection })).rows).toEqual([["2", "Bob"]]);
    const tables = await ctx.database.listTables();
    expect(tables).toHaveLength(before);
    const view = tables.find((table) => table.name === "sales_report");
    expect(view?.rowCount).toBeNull();
    expect(view?.error).toMatchObject({ code: "sql_error" });
    expect(view?.error?.message).toContain("amount");
  });

  it("keeps a healthy sales_report_2 when an import asks for the unbound view with replace omitted", async () => {
    const ctx = await unboundView("view-suffix-occupied");
    await ctx.database.run("CREATE TABLE sales_report_2 AS SELECT 'kept' AS origin, 99 AS value", { connection });
    const file = join(root, "sales-report-occupied.csv");
    writeFileSync(file, "id,name\n1,Alice\n");
    const loaded = await runDataTool(ctx, "data_load", { source: file, name: "sales_report" });
    expect(loaded.isError, loaded.content[0]?.text).toBeUndefined();
    expect(loaded.structuredContent!.tables).toMatchObject([{ name: "sales_report_3" }]);
    expect((await ctx.database.run("SELECT * FROM sales_report_3", { connection })).rows).toEqual([["1", "Alice"]]);
    expect((await ctx.database.run("SELECT * FROM sales_report_2", { connection })).rows).toEqual([["kept", 99]]);
    const tables = await ctx.database.listTables();
    expect(tables.find((table) => table.name === "sales_report_2")).toMatchObject({ rowCount: 1 });
    const view = tables.find((table) => table.name === "sales_report");
    expect(view?.rowCount).toBeNull();
    expect(view?.error).toMatchObject({ code: "sql_error" });
    expect(view?.error?.message).toContain("amount");
  });

  it("keeps a healthy sales_report_3 when one import's tables share a stem and an invalid view sits on the first suffix", async () => {
    const ctx = await context("sqlite-shared-stem");
    for (const sql of [
      "CREATE TABLE sales AS SELECT 1 AS id, 10 AS amount",
      "CREATE VIEW sales_report_2 AS SELECT id, amount FROM sales",
      "CREATE OR REPLACE TABLE sales AS SELECT 2 AS id, 20 AS total",
      "CREATE TABLE sales_report_3 AS SELECT 'kept' AS origin, 99 AS value",
    ]) {
      const result = await runDataTool(ctx, "data_sql", { sql });
      expect(result.isError, result.content[0]?.text).toBeUndefined();
    }
    const file = join(root, "sales-reports.sqlite");
    const source = new DatabaseSync(file);
    source.exec('CREATE TABLE "sales report" (origin TEXT, value INTEGER)');
    source.exec(`INSERT INTO "sales report" VALUES ('spaced', 1)`);
    source.exec('CREATE TABLE "sales-report" (origin TEXT, value INTEGER)');
    source.exec(`INSERT INTO "sales-report" VALUES ('dashed', 2)`);
    source.close();
    const loaded = await runDataTool(ctx, "data_load", { source: file });
    expect(loaded.isError, loaded.content[0]?.text).toBeUndefined();
    expect(loaded.structuredContent!.tables).toMatchObject([{ name: "sales_report" }, { name: "sales_report_4" }]);
    expect((await ctx.database.run("SELECT origin, value FROM sales_report ORDER BY origin", { connection })).rows).toEqual([["spaced", "1"]]);
    expect((await ctx.database.run("SELECT origin, value FROM sales_report_4 ORDER BY origin", { connection })).rows).toEqual([["dashed", "2"]]);
    expect((await ctx.database.run("SELECT origin, value FROM sales_report_3", { connection })).rows).toEqual([["kept", 99]]);
    const tables = await ctx.database.listTables();
    expect(tables.find((table) => table.name === "sales_report_3")).toMatchObject({ rowCount: 1 });
    const view = tables.find((table) => table.name === "sales_report_2");
    expect(view?.rowCount).toBeNull();
    expect(view?.error).toMatchObject({ code: "sql_error" });
    expect(view?.error?.message).toContain("amount");
  });

  it("keeps a healthy sales_report_2_2 when the next source collides with the name an invalid view displaced", async () => {
    const ctx = await context("sqlite-cascade-suffix");
    for (const sql of [
      "CREATE TABLE sales AS SELECT 1 AS id, 10 AS amount",
      "CREATE VIEW sales_report AS SELECT id, amount FROM sales",
      "CREATE OR REPLACE TABLE sales AS SELECT 2 AS id, 20 AS total",
      "CREATE TABLE sales_report_2_2 AS SELECT 'kept' AS origin, 99 AS value",
    ]) {
      const result = await runDataTool(ctx, "data_sql", { sql });
      expect(result.isError, result.content[0]?.text).toBeUndefined();
    }
    const file = join(root, "sales-cascade.sqlite");
    const source = new DatabaseSync(file);
    source.exec("CREATE TABLE sales_report (origin TEXT, value INTEGER)");
    source.exec("INSERT INTO sales_report VALUES ('first', 1)");
    source.exec("CREATE TABLE sales_report_2 (origin TEXT, value INTEGER)");
    source.exec("INSERT INTO sales_report_2 VALUES ('second', 2)");
    source.close();
    const loaded = await runDataTool(ctx, "data_load", { source: file });
    expect(loaded.isError, loaded.content[0]?.text).toBeUndefined();
    expect(loaded.structuredContent!.tables).toMatchObject([{ name: "sales_report_2" }, { name: "sales_report_2_3" }]);
    expect((await ctx.database.run("SELECT origin, value FROM sales_report_2", { connection })).rows).toEqual([["first", "1"]]);
    expect((await ctx.database.run("SELECT origin, value FROM sales_report_2_3", { connection })).rows).toEqual([["second", "2"]]);
    expect((await ctx.database.run("SELECT origin, value FROM sales_report_2_2", { connection })).rows).toEqual([["kept", 99]]);
    const tables = await ctx.database.listTables();
    expect(tables.find((table) => table.name === "sales_report_2_2")).toMatchObject({ rowCount: 1 });
    const view = tables.find((table) => table.name === "sales_report");
    expect(view?.rowCount).toBeNull();
    expect(view?.error).toMatchObject({ code: "sql_error" });
    expect(view?.error?.message).toContain("amount");
  });

  it("keeps the usual names when the file-family suffixes fit", async () => {
    const ctx = await context("short-prefix");
    const result = await loadData(ctx, { source: folder, name: "mixed" });
    expect(new Set(result.tables.map((table) => table.name))).toEqual(new Set(["mixed_csv", "mixed_json", "mixed_parquet"]));
    await expectAllSources(ctx, result.tables);
  });
});
