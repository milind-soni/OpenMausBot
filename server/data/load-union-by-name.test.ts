import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { chartRenderer, compileChart, validateVegaLite } from "./deps.ts";
import { createDataEngine } from "./engine.ts";
import { DataSheetStore } from "./sheet.ts";
import { loadData, type DataContext } from "./tools.ts";

const root = mkdtempSync(join(tmpdir(), "omb-load-union-"));
const parquetDir = join(root, "parquet");
const jsonDir = join(root, "json");
const engine = createDataEngine({ botFolder: (id) => join(root, "bots", id), dataDir: join(root, "data") });
const connection = "bot" as const;

beforeAll(async () => {
  mkdirSync(parquetDir);
  mkdirSync(jsonDir);
  const writer = await engine.forBot("writer");
  for (const [name, select] of [["first", "SELECT 1 AS item"], ["second", "SELECT 2 AS extra"]]) {
    const path = join(parquetDir, `${name}.parquet`).replaceAll("'", "''");
    await writer.run(`COPY (${select}) TO '${path}' (FORMAT PARQUET)`, { connection });
  }
  for (let i = 0; i < 33; i++) {
    const record = { ...Object.fromEntries(Array.from({ length: 10 }, (_, j) => [`common_${j}`, j])), [`column_${i}`]: i };
    writeFileSync(join(jsonDir, `${String(i).padStart(2, "0")}.json`), JSON.stringify([record]));
  }
});

afterAll(async () => {
  await engine.closeAll();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function context(botId: string): Promise<DataContext> {
  const database = await engine.forBot(botId);
  return {
    database,
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

describe("file imports honor the requested schema union", () => {
  it.each(["glob", "folder"])("does not union mismatched Parquet schemas when disabled for a %s", async (sourceKind) => {
    const ctx = await context(`parquet-${sourceKind}`);
    const source = sourceKind === "glob" ? join(parquetDir, "*.parquet") : parquetDir;
    await expect(loadData(ctx, { source, name: "imported", options: { union_by_name: false } })).rejects.toThrow(/schema mismatch/);
    expect(await ctx.database.listTables()).toEqual([]);
    expect(ctx.sheet.sheet().sources).toEqual([]);
  });

  it("does not force JSON to union schemas beyond its sampled files", async () => {
    const ctx = await context("json-disabled");
    await expect(loadData(ctx, { source: jsonDir, name: "imported", options: { union_by_name: false } })).rejects.toThrow(/unknown key/);
    expect(await ctx.database.listTables()).toEqual([]);
    expect(ctx.sheet.sheet().sources).toEqual([]);
  });

  it.each([true, undefined])("keeps Parquet schema union with option %s", async (union_by_name) => {
    const ctx = await context(`parquet-enabled-${String(union_by_name)}`);
    const result = await loadData(ctx, { source: parquetDir, name: "imported", options: { union_by_name } });
    expect(result.tables[0]!.rowCount).toBe(2);
    expect(result.tables[0]!.columns.map((column) => column.name)).toEqual(["item", "extra", "filename"]);
    const rows = await ctx.database.run("SELECT item, extra FROM imported ORDER BY item NULLS LAST", { connection });
    expect(rows.rows).toEqual([[1, null], [null, 2]]);
  });

  it("unions all JSON file schemas when enabled", async () => {
    const ctx = await context("json-enabled");
    const result = await loadData(ctx, { source: jsonDir, name: "imported", options: { union_by_name: true } });
    expect(result.tables[0]!.rowCount).toBe(33);
    expect(result.tables[0]!.columns.some((column) => column.name === "column_32")).toBe(true);
    const rows = await ctx.database.run("SELECT column_32 FROM imported WHERE column_32 IS NOT NULL", { connection });
    expect(rows.rows.map(([value]) => Number(value))).toEqual([32]);
  });

  it("still imports a single Parquet file when union is disabled", async () => {
    const ctx = await context("single-file");
    const result = await loadData(ctx, { source: join(parquetDir, "first.parquet"), name: "imported", options: { union_by_name: false } });
    expect(result.tables[0]!.rowCount).toBe(1);
    expect(result.tables[0]!.columns.map((column) => column.name)).toEqual(["item"]);
  });
});
