import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { chartRenderer, compileChart, validateVegaLite } from "./deps.ts";
import { createDataEngine, quoteIdentifier } from "./engine.ts";
import { DataSheetStore } from "./sheet.ts";
import { loadData, type DataContext } from "./tools.ts";

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

    const reloaded = await loadData(ctx, { source: folder, name: "t".repeat(length), replace: true });
    expect(reloaded.tables.map((table) => table.name)).toEqual(result.tables.map((table) => table.name));
    await expectAllSources(ctx, reloaded.tables);
    expect(await ctx.database.listTables()).toHaveLength(3);
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

  it("keeps the usual names when the file-family suffixes fit", async () => {
    const ctx = await context("short-prefix");
    const result = await loadData(ctx, { source: folder, name: "mixed" });
    expect(new Set(result.tables.map((table) => table.name))).toEqual(new Set(["mixed_csv", "mixed_json", "mixed_parquet"]));
    await expectAllSources(ctx, result.tables);
  });
});
