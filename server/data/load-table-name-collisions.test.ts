import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { chartRenderer, compileChart, validateVegaLite } from "./deps.ts";
import { createDataEngine, quoteIdentifier } from "./engine.ts";
import { DataSheetStore, SHEET_FILE } from "./sheet.ts";
import { loadData, runDataTool, stripCredentials, type DataContext } from "./tools.ts";

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

  it("keeps an explicitly named sales_report_2 when a later import asks for the invalid view", async () => {
    const ctx = await unboundView("explicit-suffix-kept");
    const file = join(root, "explicit-suffix.csv");
    writeFileSync(file, "id,name\n1,Alice\n");
    const named = await runDataTool(ctx, "data_load", { source: file, name: "sales_report_2" });
    expect(named.isError, named.content[0]?.text).toBeUndefined();
    expect(named.structuredContent!.tables).toMatchObject([{ name: "sales_report_2" }]);

    writeFileSync(file, "id,name\n2,Bob\n");
    const displaced = await runDataTool(ctx, "data_load", { source: file, name: "sales_report" });
    expect(displaced.isError, displaced.content[0]?.text).toBeUndefined();
    expect(displaced.structuredContent!.tables).toMatchObject([{ name: "sales_report_3" }]);
    expect((await ctx.database.run("SELECT * FROM sales_report_2", { connection })).rows).toEqual([["1", "Alice"]]);
    expect((await ctx.database.run("SELECT * FROM sales_report_3", { connection })).rows).toEqual([["2", "Bob"]]);
    const tables = await ctx.database.listTables();
    const view = tables.find((table) => table.name === "sales_report");
    expect(view?.rowCount).toBeNull();
    expect(view?.error).toMatchObject({ code: "sql_error" });
    expect(view?.error?.message).toContain("amount");
    expect(ctx.sheet.sheet().sources.find((source) => source.name === "sales_report_2")).toMatchObject({ requested: "sales_report_2" });
    expect(ctx.sheet.sheet().sources.find((source) => source.name === "sales_report_3")).toMatchObject({ requested: "sales_report" });
  });

  it("reloads a mixed folder onto the csv suffix an invalid view displaced", async () => {
    const ctx = await context("folder-mixed-reload");
    for (const sql of [
      "CREATE TABLE sales AS SELECT 1 AS id, 10 AS amount",
      "CREATE VIEW sales_csv AS SELECT id, amount FROM sales",
      "CREATE OR REPLACE TABLE sales AS SELECT 2 AS id, 20 AS total",
    ]) {
      const result = await runDataTool(ctx, "data_sql", { sql });
      expect(result.isError, result.content[0]?.text).toBeUndefined();
    }
    const sales = join(root, "sales");
    mkdirSync(sales);
    writeFileSync(join(sales, "rows.csv"), "origin,value\ncsv,1\n");
    writeFileSync(join(sales, "rows.json"), JSON.stringify([{ origin: "json", value: 2 }]));
    const loaded = await loadData(ctx, { source: sales });
    expect(loaded.tables.map((table) => table.name).sort()).toEqual(["sales_csv_2", "sales_json"]);

    writeFileSync(join(sales, "rows.csv"), "origin,value\ncsv,9\n");
    const reloaded = await loadData(ctx, { source: sales });
    expect(reloaded.tables.map((table) => table.name).sort()).toEqual(["sales_csv_2", "sales_json"]);
    const read = async (name: string) => (await ctx.database.run(`SELECT origin, value FROM ${quoteIdentifier(name)}`, { connection })).rows
      .map(([origin, value]) => [origin, Number(value)]);
    expect(await read("sales_csv_2")).toEqual([["csv", 9]]);
    expect(await read("sales_json")).toEqual([["json", 2]]);
    const tables = await ctx.database.listTables();
    expect(tables.map((table) => table.name)).not.toContain("sales_csv_3");
    expect(tables).toHaveLength(4);
    const view = tables.find((table) => table.name === "sales_csv");
    expect(view?.rowCount).toBeNull();
    expect(view?.error).toMatchObject({ code: "sql_error" });
    expect(view?.error?.message).toContain("amount");
    expect(ctx.sheet.sheet().sources.find((source) => source.name === "sales_csv_2")).toMatchObject({ requested: "sales_csv" });
    expect(ctx.sheet.sheet().sources.find((source) => source.name === "sales_json")).toMatchObject({ requested: "sales_json" });
  });

  it("does not reuse a displaced suffix whose sheet record has no requested name", async () => {
    const ctx = await unboundView("view-reload-without-requested");
    const file = join(root, "sales-report-without-requested.csv");
    writeFileSync(file, "id,name\n1,Alice\n");
    const loaded = await runDataTool(ctx, "data_load", { source: file, name: "sales_report" });
    expect(loaded.isError, loaded.content[0]?.text).toBeUndefined();
    expect(loaded.structuredContent!.tables).toMatchObject([{ name: "sales_report_2" }]);
    const prior = ctx.sheet.sheet().sources.find((source) => source.name === "sales_report_2");
    expect(prior).toBeDefined();
    const recorded = { ...prior! };
    delete recorded.requested;
    ctx.sheet.recordSource(recorded);
    writeFileSync(file, "id,name\n2,Bob\n");
    const reloaded = await runDataTool(ctx, "data_load", { source: file, name: "sales_report" });
    expect(reloaded.isError, reloaded.content[0]?.text).toBeUndefined();
    expect(reloaded.structuredContent!.tables).toMatchObject([{ name: "sales_report_3" }]);
    expect((await ctx.database.run("SELECT * FROM sales_report_2", { connection })).rows).toEqual([["1", "Alice"]]);
    expect((await ctx.database.run("SELECT * FROM sales_report_3", { connection })).rows).toEqual([["2", "Bob"]]);
    const view = (await ctx.database.listTables()).find((table) => table.name === "sales_report");
    expect(view?.rowCount).toBeNull();
    expect(view?.error).toMatchObject({ code: "sql_error" });
  });

  it("reloads the displaced name twice more without minting further tables", async () => {
    const ctx = await unboundView("explicit-suffix-repeat");
    const file = join(root, "explicit-suffix-repeat.csv");
    writeFileSync(file, "id,name\n1,Alice\n");
    const named = await runDataTool(ctx, "data_load", { source: file, name: "sales_report_2" });
    expect(named.isError, named.content[0]?.text).toBeUndefined();
    const displaced = await runDataTool(ctx, "data_load", { source: file, name: "sales_report" });
    expect(displaced.isError, displaced.content[0]?.text).toBeUndefined();
    expect(displaced.structuredContent!.tables).toMatchObject([{ name: "sales_report_3" }]);
    const before = (await ctx.database.listTables()).length;

    writeFileSync(file, "id,name\n3,Cara\n");
    const again = await runDataTool(ctx, "data_load", { source: file, name: "sales_report", replace: true });
    expect(again.isError, again.content[0]?.text).toBeUndefined();
    writeFileSync(file, "id,name\n4,Dora\n");
    const third = await runDataTool(ctx, "data_load", { source: file, name: "sales_report", replace: true });
    expect(third.isError, third.content[0]?.text).toBeUndefined();

    expect(third.structuredContent!.tables).toMatchObject([{ name: "sales_report_3", rowCount: 1 }]);
    expect((await ctx.database.run("SELECT * FROM sales_report_2", { connection })).rows).toEqual([["1", "Alice"]]);
    expect((await ctx.database.run("SELECT * FROM sales_report_3", { connection })).rows).toEqual([["4", "Dora"]]);
    const tables = await ctx.database.listTables();
    expect(tables).toHaveLength(before);
    expect(tables.map((table) => table.name)).not.toContain("sales_report_4");
    expect(tables.map((table) => table.name)).not.toContain("sales_report_5");
    const view = tables.find((table) => table.name === "sales_report");
    expect(view?.rowCount).toBeNull();
    expect(view?.error).toMatchObject({ code: "sql_error" });
  });

  it("keeps a table data_sql created over a displaced suffix when the csv reloads", async () => {
    const ctx = await unboundView("sql-replaces-suffix");
    const file = join(root, "sales-report-sql-replace.csv");
    writeFileSync(file, "id,name\n1,Alice\n");
    const loaded = await runDataTool(ctx, "data_load", { source: file, name: "sales_report" });
    expect(loaded.isError, loaded.content[0]?.text).toBeUndefined();
    expect(loaded.structuredContent!.tables).toMatchObject([{ name: "sales_report_2" }]);
    const replaced = await runDataTool(ctx, "data_sql", { sql: "CREATE OR REPLACE TABLE sales_report_2 AS SELECT 'sql' AS origin, 7 AS value" });
    expect(replaced.isError, replaced.content[0]?.text).toBeUndefined();
    expect(ctx.sheet.sheet().sources.find((source) => source.name === "sales_report_2")).toBeUndefined();

    writeFileSync(file, "id,name\n2,Bob\n");
    const reloaded = await runDataTool(ctx, "data_load", { source: file, name: "sales_report" });
    expect(reloaded.isError, reloaded.content[0]?.text).toBeUndefined();
    expect(reloaded.structuredContent!.tables).toMatchObject([{ name: "sales_report_3" }]);
    expect((await ctx.database.run("SELECT * FROM sales_report_2", { connection })).rows).toEqual([["sql", 7]]);
    expect((await ctx.database.run("SELECT * FROM sales_report_3", { connection })).rows).toEqual([["2", "Bob"]]);
    const view = (await ctx.database.listTables()).find((table) => table.name === "sales_report");
    expect(view?.rowCount).toBeNull();
    expect(view?.error).toMatchObject({ code: "sql_error" });
  });

  it("gives two concurrent loads of one blocked name distinct tables", async () => {
    const ctx = await unboundView("concurrent-blocked-name");
    const ada = join(root, "concurrent-ada.csv");
    const bea = join(root, "concurrent-bea.csv");
    writeFileSync(ada, "id,name\n1,Ada\n");
    writeFileSync(bea, "id,name\n2,Bea\n");
    const [left, right] = await Promise.all([
      loadData(ctx, { source: ada, name: "sales_report" }),
      loadData(ctx, { source: bea, name: "sales_report" }),
    ]);
    const names = [left.tables[0]!.name, right.tables[0]!.name].sort();
    expect(names).toEqual(["sales_report_2", "sales_report_3"]);
    const read = async (name: string) => (await ctx.database.run(`SELECT id, name FROM ${quoteIdentifier(name)}`, { connection })).rows;
    expect([await read(names[0]!), await read(names[1]!)].sort((a, b) => String(a[0]?.[1]).localeCompare(String(b[0]?.[1]))))
      .toEqual([[["1", "Ada"]], [["2", "Bea"]]]);
    const view = (await ctx.database.listTables()).find((table) => table.name === "sales_report");
    expect(view?.rowCount).toBeNull();
    expect(view?.error).toMatchObject({ code: "sql_error" });
  });

  it("does not replace a healthy sales_report_2 when two sqlite tables share its stem", async () => {
    const ctx = await context("sqlite-shared-stem-keeps-suffix");
    await ctx.database.run("CREATE TABLE sales_report_2 AS SELECT 'kept' AS origin, 99 AS value", { connection });
    const file = join(root, "sales-shared-stem-keeps.sqlite");
    const source = new DatabaseSync(file);
    source.exec('CREATE TABLE "sales report" (origin TEXT, value INTEGER)');
    source.exec(`INSERT INTO "sales report" VALUES ('spaced', 1)`);
    source.exec('CREATE TABLE "sales-report" (origin TEXT, value INTEGER)');
    source.exec(`INSERT INTO "sales-report" VALUES ('dashed', 2)`);
    source.close();
    const loaded = await runDataTool(ctx, "data_load", { source: file });
    expect(loaded.isError, loaded.content[0]?.text).toBeUndefined();
    expect(loaded.structuredContent!.tables).toMatchObject([{ name: "sales_report" }, { name: "sales_report_3" }]);
    expect((await ctx.database.run("SELECT origin, value FROM sales_report ORDER BY origin", { connection })).rows).toEqual([["spaced", "1"]]);
    expect((await ctx.database.run("SELECT origin, value FROM sales_report_3 ORDER BY origin", { connection })).rows).toEqual([["dashed", "2"]]);
    expect((await ctx.database.run("SELECT origin, value FROM sales_report_2", { connection })).rows).toEqual([["kept", 99]]);
    expect(ctx.sheet.sheet().sources.find((entry) => entry.name === "sales_report_2")).toBeUndefined();
  });

  it.each([
    ["quoted uppercase", `CREATE OR REPLACE TABLE "SALES_REPORT_2" AS SELECT 'quoted' AS origin, 7 AS value`],
    ["three-part qualified", "CREATE OR REPLACE TABLE data.main.sales_report_2 AS SELECT 'qualified' AS origin, 7 AS value"],
  ])("clears the import record when data_sql replaces it with a %s name", async (label, sql) => {
    const ctx = await unboundView(`forget-${label.replaceAll(" ", "-")}`);
    const file = join(root, `forget-${label.replaceAll(" ", "-")}.csv`);
    writeFileSync(file, "id,name\n1,Alice\n");
    const loaded = await runDataTool(ctx, "data_load", { source: file, name: "sales_report" });
    expect(loaded.isError, loaded.content[0]?.text).toBeUndefined();
    expect(loaded.structuredContent!.tables).toMatchObject([{ name: "sales_report_2" }]);
    const replaced = await runDataTool(ctx, "data_sql", { sql });
    expect(replaced.isError, replaced.content[0]?.text).toBeUndefined();
    expect(ctx.sheet.sheet().sources.find((entry) => entry.name.toLowerCase() === "sales_report_2")).toBeUndefined();
  });

  it("does not replace a displaced suffix from the sheet snapshot taken before listTables while the SQL write is still in flight", async () => {
    const ctx = await unboundView("stale-ownership");
    const panel: DataContext = { ...ctx, connection: "panel" };
    const file = join(root, "stale-ownership.csv");
    writeFileSync(file, "id,name\n1,Alice\n");
    const loaded = await runDataTool(ctx, "data_load", { source: file, name: "sales_report" });
    expect(loaded.isError, loaded.content[0]?.text).toBeUndefined();
    expect(loaded.structuredContent!.tables).toMatchObject([{ name: "sales_report_2" }]);
    const before = (await ctx.database.listTables()).map((table) => table.name).sort();

    const sql = "CREATE OR REPLACE TABLE sales_report_2 AS SELECT 'sql' AS origin, 7 AS value";
    const run = ctx.database.run.bind(ctx.database);
    let releaseSql!: () => void;
    const sqlGate = new Promise<void>((resolve) => { releaseSql = resolve; });
    let markSqlInFlight!: () => void;
    const sqlInFlight = new Promise<void>((resolve) => { markSqlInFlight = resolve; });
    let sqlFinished!: ReturnType<typeof runDataTool>;
    let held = false;
    ctx.database.run = async (statement, options) => {
      if (!held && statement === sql) {
        held = true;
        markSqlInFlight();
        await sqlGate;
        return run(statement, options);
      }
      if (statement.startsWith('CREATE OR REPLACE TABLE "sales_report_2"')) {
        await sqlFinished;
        return run(statement, options);
      }
      return run(statement, options);
    };

    const listTables = ctx.database.listTables.bind(ctx.database);
    let interleaved = false;
    ctx.database.listTables = async () => {
      const tables = await listTables();
      if (!interleaved) {
        interleaved = true;
        sqlFinished = runDataTool(ctx, "data_sql", { sql });
        await sqlInFlight;
        releaseSql();
      }
      return tables;
    };

    writeFileSync(file, "id,name\n2,Bob\n");
    const reloaded = await runDataTool(panel, "data_load", { source: file, name: "sales_report" });
    const replaced = await sqlFinished;
    expect(replaced.isError, replaced.content[0]?.text).toBeUndefined();
    expect(reloaded.isError, reloaded.content[0]?.text).toBeUndefined();
    expect(interleaved).toBe(true);
    expect((await ctx.database.run("SELECT * FROM sales_report_2", { connection })).rows).toEqual([["sql", 7]]);
    expect(reloaded.structuredContent!.tables).toMatchObject([{ name: "sales_report_3" }]);
    expect((await ctx.database.run("SELECT * FROM sales_report_3", { connection })).rows).toEqual([["2", "Bob"]]);
    expect((await listTables()).map((table) => table.name).sort()).toEqual([...before, "sales_report_3"].sort());
    expect(ctx.sheet.sheet().sources.find((entry) => entry.name === "sales_report_2")).toBeUndefined();
    expect(ctx.sheet.sheet().sources.find((entry) => entry.name === "sales_report_3")).toMatchObject({ requested: "sales_report" });
  });

  it.each([
    ["the database alias", "CREATE OR REPLACE TABLE data.sales_report_2 AS SELECT 'sql' AS origin, 7 AS value"],
    ["an uppercase database alias", "CREATE OR REPLACE TABLE DATA.sales_report_2 AS SELECT 'sql' AS origin, 7 AS value"],
    ["a quoted database alias", `CREATE OR REPLACE TABLE "DATA"."sales_report_2" AS SELECT 'sql' AS origin, 7 AS value`],
  ])("clears the import record when data_sql replaces the displaced suffix through %s", async (label, sql) => {
    const slug = label.replaceAll(" ", "-");
    const ctx = await unboundView(`catalog-${slug}`);
    const file = join(root, `catalog-${slug}.csv`);
    writeFileSync(file, "id,name\n1,Alice\n");
    const loaded = await runDataTool(ctx, "data_load", { source: file, name: "sales_report" });
    expect(loaded.isError, loaded.content[0]?.text).toBeUndefined();
    expect(loaded.structuredContent!.tables).toMatchObject([{ name: "sales_report_2" }]);
    await runDataTool(ctx, "data_sql", { sql });
    expect((await ctx.database.run("SELECT * FROM sales_report_2", { connection })).rows).toEqual([["sql", 7]]);
    expect(ctx.sheet.sheet().sources.find((source) => source.name.toLowerCase() === "sales_report_2")).toBeUndefined();

    writeFileSync(file, "id,name\n2,Bob\n");
    const reloaded = await runDataTool(ctx, "data_load", { source: file, name: "sales_report" });
    expect(reloaded.isError, reloaded.content[0]?.text).toBeUndefined();
    expect(reloaded.structuredContent!.tables).toMatchObject([{ name: "sales_report_3" }]);
    expect((await ctx.database.run("SELECT * FROM sales_report_2", { connection })).rows).toEqual([["sql", 7]]);
    expect((await ctx.database.run("SELECT * FROM sales_report_3", { connection })).rows).toEqual([["2", "Bob"]]);
  });

  it("leaves the import record when data_sql replaces a table in another attached database", async () => {
    const ctx = await context("other-catalog");
    await ctx.database.run("CREATE TABLE sales_report AS SELECT 'kept' AS origin, 99 AS value", { connection });
    const file = join(root, "other-catalog.csv");
    writeFileSync(file, "id,name\n1,Alice\n");
    const loaded = await runDataTool(ctx, "data_load", { source: file, name: "sales_report", replace: false });
    expect(loaded.isError, loaded.content[0]?.text).toBeUndefined();
    expect(loaded.structuredContent!.tables).toMatchObject([{ name: "sales_report_2" }]);
    const other = join(root, "analytics.duckdb");
    await ctx.database.run(`ATTACH '${other.replaceAll("'", "''")}' AS analytics`, { connection });
    await runDataTool(ctx, "data_sql", { sql: "CREATE OR REPLACE TABLE analytics.sales_report_2 AS SELECT 'alias' AS origin, 8 AS value" });
    expect(ctx.sheet.sheet().sources.find((source) => source.name === "sales_report_2")).toMatchObject({ requested: "sales_report" });
    expect((await ctx.database.run("SELECT * FROM analytics.main.sales_report_2", { connection })).rows).toEqual([["alias", 8]]);
    await runDataTool(ctx, "data_sql", { sql: "CREATE OR REPLACE TABLE analytics.main.sales_report_2 AS SELECT 'other' AS origin, 8 AS value" });
    expect((await ctx.database.run("SELECT * FROM analytics.main.sales_report_2", { connection })).rows).toEqual([["other", 8]]);

    writeFileSync(file, "id,name\n2,Bob\n");
    const reloaded = await runDataTool(ctx, "data_load", { source: file, name: "sales_report" });
    expect(reloaded.isError, reloaded.content[0]?.text).toBeUndefined();
    expect((await ctx.database.run("SELECT * FROM sales_report", { connection })).rows).toEqual([["kept", 99]]);
    expect((await ctx.database.run("SELECT * FROM sales_report_2", { connection })).rows).toEqual([["2", "Bob"]]);
    expect(ctx.sheet.sheet().sources.find((source) => source.name === "sales_report_2")).toMatchObject({ requested: "sales_report" });
    expect(reloaded.structuredContent!.tables).toMatchObject([{ name: "sales_report_2" }]);
    await ctx.database.run("DETACH analytics", { connection });
  });

  it("does not reuse a displaced suffix whose sheet record has no source identity", async () => {
    const ctx = await unboundView("view-reload-without-identity");
    const file = join(root, "sales-report-without-identity.csv");
    writeFileSync(file, "id,name\n1,Alice\n");
    const loaded = await runDataTool(ctx, "data_load", { source: file, name: "sales_report" });
    expect(loaded.isError, loaded.content[0]?.text).toBeUndefined();
    expect(loaded.structuredContent!.tables).toMatchObject([{ name: "sales_report_2" }]);
    const prior = ctx.sheet.sheet().sources.find((source) => source.name === "sales_report_2");
    expect(prior?.identity).toMatch(/^[a-f0-9]{64}$/);
    const recorded = { ...prior! };
    delete recorded.identity;
    ctx.sheet.recordSource(recorded);
    writeFileSync(file, "id,name\n2,Bob\n");
    const reloaded = await runDataTool(ctx, "data_load", { source: file, name: "sales_report" });
    expect(reloaded.isError, reloaded.content[0]?.text).toBeUndefined();
    expect(reloaded.structuredContent!.tables).toMatchObject([{ name: "sales_report_3" }]);
    expect((await ctx.database.run("SELECT * FROM sales_report_2", { connection })).rows).toEqual([["1", "Alice"]]);
    expect((await ctx.database.run("SELECT * FROM sales_report_3", { connection })).rows).toEqual([["2", "Bob"]]);
    const view = (await ctx.database.listTables()).find((table) => table.name === "sales_report");
    expect(view?.rowCount).toBeNull();
    expect(view?.error).toMatchObject({ code: "sql_error" });
  });

  it("keeps January when another report URL differs only by a redacted object_key", async () => {
    const bodies = new Map([["january", "month\njanuary\n"], ["february", "month\nfebruary\n"]]);
    const server = createServer((request, response) => {
      const key = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("object_key") ?? "";
      const body = bodies.get(key);
      if (body === undefined) { response.writeHead(404).end(); return; }
      response.writeHead(200, { "content-type": "text/csv", "content-length": Buffer.byteLength(body) });
      response.end(request.method === "HEAD" ? undefined : body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const botId = "distinct-object-key";
    const ctx = await context(botId);
    const january = `http://127.0.0.1:${port}/report.csv?object_key=january&token=super-secret-token`;
    const february = `http://127.0.0.1:${port}/report.csv?object_key=february&token=other-secret-token`;
    const read = async (name: string) => {
      const tables = await ctx.database.listTables();
      if (!tables.some((table) => table.name === name)) return null;
      return (await ctx.database.run(`SELECT month FROM ${quoteIdentifier(name)}`, { connection })).rows;
    };
    try {
      await ctx.database.run("CREATE TABLE report AS SELECT 'kept' AS month", { connection });
      expect(stripCredentials(january)).toBe(stripCredentials(february));
      const first = await loadData(ctx, { source: january, replace: false });
      expect(first.tables.map((table) => table.name)).toEqual(["report_2"]);
      const second = await loadData(ctx, { source: february });
      expect({
        placed: second.tables.map((table) => table.name),
        report: await read("report"),
        report_2: await read("report_2"),
        report_3: await read("report_3"),
      }).toEqual({
        placed: ["report_3"],
        report: [["kept"]],
        report_2: [["january"]],
        report_3: [["february"]],
      });

      bodies.set("january", "month\njanuary-reloaded\n");
      const reloaded = await loadData(ctx, { source: january });
      expect(reloaded.tables.map((table) => table.name)).toEqual(["report_2"]);
      expect(await read("report")).toEqual([["kept"]]);
      expect(await read("report_2")).toEqual([["january-reloaded"]]);
      expect(await read("report_3")).toEqual([["february"]]);
      expect((await ctx.database.listTables()).map((table) => table.name)).not.toContain("report_4");

      const sources = ctx.sheet.sheet().sources;
      const januarySource = sources.find((source) => source.name === "report_2");
      const februarySource = sources.find((source) => source.name === "report_3");
      expect(januarySource?.source).toBe(februarySource?.source);
      expect(januarySource?.source).toContain("object_key=***");
      expect(januarySource?.source).toContain("token=***");
      expect(januarySource?.identity).toBe(createHash("sha256").update(january).digest("hex"));
      expect(februarySource?.identity).toBe(createHash("sha256").update(february).digest("hex"));
      expect(januarySource?.identity).not.toBe(februarySource?.identity);
      const stored = readFileSync(join(root, "sheets", botId, SHEET_FILE), "utf8");
      expect(stored).not.toContain("super-secret-token");
      expect(stored).not.toContain("other-secret-token");
      expect(stored).not.toContain("object_key=january");
      expect(stored).not.toContain("object_key=february");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 90_000);
});
