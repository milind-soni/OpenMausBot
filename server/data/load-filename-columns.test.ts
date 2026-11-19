import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { chartRenderer, compileChart, validateVegaLite } from "./deps.ts";
import { createDataEngine, quoteIdentifier } from "./engine.ts";
import { DataSheetStore } from "./sheet.ts";
import { loadData, quoteLiteral, type DataContext } from "./tools.ts";

const root = mkdtempSync(join(tmpdir(), "omb-load-filenames-"));
const engine = createDataEngine({ botFolder: (id) => join(root, "bots", id), dataDir: join(root, "data") });
const connection = "bot" as const;

beforeAll(async () => {
  const writer = await engine.forBot("writer");
  for (const format of ["csv", "tsv", "json", "parquet"]) {
    const dir = join(root, format);
    mkdirSync(dir);
    for (const [index, label] of ["first.txt", "second.txt"].entries()) {
      const file = join(dir, `${index + 1}.${format}`);
      if (format === "csv") writeFileSync(file, `filename,value\n${label},${index + 1}\n`);
      else if (format === "tsv") writeFileSync(file, `FILENAME\tvalue\n${label}\t${index + 1}\n`);
      else if (format === "json") writeFileSync(file, JSON.stringify({ filename: label, value: index + 1 }));
      else await writer.run(`COPY (SELECT ${quoteLiteral(label)} AS filename, ${index + 1} AS value) TO ${quoteLiteral(file)} (FORMAT PARQUET)`, { connection });
    }
  }
});

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

describe("source file names beside an imported filename column", () => {
  it.each(["csv", "tsv", "json", "parquet"])("preserves original values and source paths for %s files", async (format) => {
    const ctx = await context(format);
    const dir = join(root, format);
    const source = format === "tsv" || format === "parquet" ? join(dir, `*.${format}`) : dir;
    if (format === "csv") await ctx.database.run("CREATE TABLE files AS SELECT 'old.txt' AS filename", { connection });
    const loaded = await loadData(ctx, { source, name: "files" });
    expect(loaded.tables).toHaveLength(1);
    expect(loaded.tables[0]!.rowCount).toBe(2);
    const rows = await ctx.database.run("SELECT filename, value, source_filename FROM files ORDER BY value", { connection });
    expect(rows.rows.map(([filename, value, sourceFile]) => [filename, Number(value), sourceFile])).toEqual([
      ["first.txt", 1, join(dir, `1.${format}`)], ["second.txt", 2, join(dir, `2.${format}`)],
    ]);
    expect(loaded.warnings.join(" ")).toContain("source_filename");
    expect(ctx.sheet.sheet().sources[0]!.columns.map((column) => column.name.toLowerCase())).toEqual(["filename", "value", "source_filename"]);
  });

  it("chooses an unused source column without replacing existing provenance fields", async () => {
    const dir = join(root, "already-tracked");
    mkdirSync(dir);
    writeFileSync(join(dir, "manifest.csv"), "filename,source_filename,SOURCE_FILENAME_2\nreport.txt,original.csv,archive.csv\n");
    const ctx = await context("already-tracked");
    await loadData(ctx, { source: dir, name: "files" });
    expect((await ctx.database.run("SELECT * FROM files", { connection })).rows).toEqual([
      ["report.txt", "original.csv", "archive.csv", join(dir, "manifest.csv")],
    ]);
    expect((await ctx.database.describe("files", { connection })).columns.map((column) => column.name)).toEqual([
      "filename", "source_filename", "SOURCE_FILENAME_2", "source_filename_3",
    ]);
  });

  it("keeps the usual filename column when the input does not have one", async () => {
    const dir = join(root, "ordinary");
    mkdirSync(dir);
    const file = join(dir, "data.csv");
    writeFileSync(file, "value\n1\n");
    const ctx = await context("ordinary");
    const loaded = await loadData(ctx, { source: dir, name: "files" });
    expect(loaded.warnings).toEqual([]);
    expect((await ctx.database.run("SELECT filename FROM files", { connection })).rows).toEqual([[file]]);
    expect(loaded.tables[0]!.columns.map((column) => column.name)).toEqual(["value", "filename"]);
  });

  it("leaves a single file's own filename column unchanged", async () => {
    const ctx = await context("single");
    const loaded = await loadData(ctx, { source: join(root, "csv", "1.csv"), name: "files" });
    expect(loaded.warnings).toEqual([]);
    expect(loaded.tables[0]!.columns.map((column) => column.name)).toEqual(["filename", "value"]);
    expect((await ctx.database.run("SELECT filename FROM files", { connection })).rows).toEqual([["first.txt"]]);
  });

  it("leaves an existing table and source receipt alone when the files are missing", async () => {
    const ctx = await context("missing");
    await ctx.database.run("CREATE TABLE files AS SELECT 'kept' AS filename", { connection });
    await expect(loadData(ctx, { source: join(root, "missing", "*.csv"), name: "files" })).rejects.toThrow(/No files found/);
    expect((await ctx.database.run(`SELECT * FROM ${quoteIdentifier("files")}`, { connection })).rows).toEqual([["kept"]]);
    expect(ctx.sheet.sheet().sources).toEqual([]);
  });
});
