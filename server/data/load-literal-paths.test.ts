import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";

import { chartRenderer, compileChart, validateVegaLite } from "./deps.ts";
import { createDataEngine } from "./engine.ts";
import { DataSheetStore } from "./sheet.ts";
import { loadData, type DataContext } from "./tools.ts";

const root = mkdtempSync(join(tmpdir(), "omb-load-literal-"));
const engine = createDataEngine({ botFolder: (id) => join(root, "bots", id), dataDir: join(root, "data") });
const connection = "bot" as const;

afterAll(async () => {
  await engine.closeAll();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function context(botId: string): Promise<DataContext> {
  return {
    database: await engine.forBot(botId), sheet: new DataSheetStore({ botId, dir: join(root, "sheets", botId) }),
    renderer: chartRenderer, compileChart, validateVegaLite, exportRoots: () => [root],
    signal: new AbortController().signal, connection, by: "bot",
  };
}

async function products(ctx: DataContext) {
  return (await ctx.database.run("SELECT product, amount FROM sales ORDER BY product", { connection })).rows
    .map(([product, amount]) => [product, Number(amount)]);
}

describe("literal local paths beside explicit Data globs", () => {
  it("loads an existing bracketed directory without reading a matching neighbour", async () => {
    const folder = join(root, "[Exports]");
    mkdirSync(join(folder, "nested"), { recursive: true });
    writeFileSync(join(folder, "sales.csv"), "product,amount\nPencil,3\n");
    writeFileSync(join(folder, "nested", "restock.CSV"), "product,amount\nEraser,4\n");
    mkdirSync(join(root, "E"));
    writeFileSync(join(root, "E", "other.csv"), "product,amount\nUnrelated,999\n");
    const ctx = await context("bracket-folder");
    const loaded = await loadData(ctx, { source: folder, name: "sales" });
    expect(loaded.tables[0]!.rowCount).toBe(2);
    expect(await products(ctx)).toEqual([["Eraser", 4], ["Pencil", 3]]);
    expect(ctx.sheet.sheet().sources[0]).toMatchObject({ kind: "folder", source: folder });
    const filenames = (await ctx.database.run("SELECT filename FROM sales", { connection })).rows.flat();
    expect(new Set(filenames)).toEqual(new Set([join(folder, "sales.csv"), join(folder, "nested", "restock.CSV")]));
  });

  it("keeps a bracketed single CSV's name and columns", async () => {
    const file = join(root, "sales [2026].csv");
    writeFileSync(file, "product,amount\nNotebook,5\n");
    const ctx = await context("bracket-file");
    const loaded = await loadData(ctx, { source: file });
    expect(loaded.tables.map((table) => table.name)).toEqual(["sales_2026"]);
    expect(loaded.tables[0]!.columns.map((column) => column.name)).toEqual(["product", "amount"]);
    expect((await ctx.database.run("SELECT product, amount FROM sales_2026", { connection })).rows)
      .toEqual([["Notebook", "5"]]);
    expect(ctx.sheet.sheet().sources[0]).toMatchObject({ kind: "csv", source: file });
  });

  it("preserves an explicitly supplied character-class glob", async () => {
    for (const [folder, amount] of [["A", 1], ["B", 2], ["[AB]", 999]] as const) {
      mkdirSync(join(root, folder));
      writeFileSync(join(root, folder, "sales.csv"), `product,amount\n${folder},${amount}\n`);
    }
    const ctx = await context("explicit-glob");
    await loadData(ctx, { source: join(root, "[AB]", "*.csv"), name: "sales" });
    expect(await products(ctx)).toEqual([["A", 1], ["B", 2]]);
  });

  it("still discovers nested compressed and upper-case files in ordinary folders", async () => {
    const folder = join(root, "ordinary");
    mkdirSync(join(folder, "nested"), { recursive: true });
    writeFileSync(join(folder, "sales.csv.gz"), gzipSync("product,amount\nPencil,3\n"));
    writeFileSync(join(folder, "nested", "restock.CSV"), "product,amount\nEraser,4\n");
    const ctx = await context("ordinary");
    await loadData(ctx, { source: folder, name: "sales", kind: "folder" });
    expect(await products(ctx)).toEqual([["Eraser", 4], ["Pencil", 3]]);
  });

  it.each(["missing.csv", "missing-*.csv"])("leaves the existing table intact for %s", async (file) => {
    const ctx = await context(file === "missing.csv" ? "missing-file" : "missing-glob");
    await ctx.database.run("CREATE TABLE sales AS SELECT 42 AS kept", { connection });
    await expect(loadData(ctx, { source: join(root, file), name: "sales" })).rejects.toThrow(/does not exist|No files found/);
    expect((await ctx.database.run("SELECT * FROM sales", { connection })).rows).toEqual([[42]]);
    expect(ctx.sheet.sheet().sources).toEqual([]);
  });
});
