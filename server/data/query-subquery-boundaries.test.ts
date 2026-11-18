import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { chartRenderer, compileChart, validateVegaLite } from "./deps.ts";
import { createDataEngine } from "./engine.ts";
import { DataSheetStore } from "./sheet.ts";
import { describeTarget, exportData, quoteLiteral, showCard, type DataContext } from "./tools.ts";

const root = mkdtempSync(join(tmpdir(), "omb-query-boundaries-"));
const engine = createDataEngine({ botFolder: (id) => join(root, "bots", id), dataDir: join(root, "data") });
const connection = "bot" as const;
let sequence = 0;

afterAll(async () => {
  await engine.closeAll();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function context(): Promise<DataContext> {
  const botId = `case-${++sequence}`;
  return {
    database: await engine.forBot(botId),
    sheet: new DataSheetStore({ botId, dir: join(root, "sheets", botId) }),
    renderer: chartRenderer,
    compileChart,
    validateVegaLite,
    exportRoots: () => [join(root, "exports", botId)],
    signal: new AbortController().signal,
    connection,
    by: "bot",
  };
}

type Operation = "describe" | "show" | "export";

async function valueFrom(ctx: DataContext, operation: Operation, sql: string): Promise<string> {
  if (operation === "describe") {
    const result = await describeTarget(ctx, sql);
    expect(result.rowCount).toBe(1);
    expect(result.columns[0]!.name).toBe("value");
    return result.columns[0]!.sample![0]!;
  }
  let resultSql: string;
  if (operation === "show") {
    const result = await showCard(ctx, { kind: "table", sql });
    expect(result.rowCount).toBe(1);
    expect(ctx.sheet.card(result.id)!.sql).toBe(sql);
    resultSql = `SELECT value FROM omb_results.${result.id}`;
  } else {
    const result = await exportData(ctx, { format: "csv", sql });
    expect(result.rowCount).toBe(1);
    resultSql = `SELECT value FROM read_csv(${quoteLiteral(result.path)}, delim=',', header=true)`;
  }
  const rows = (await ctx.database.run(resultSql, { connection })).rows;
  expect(rows).toHaveLength(1);
  return String(rows[0]![0]);
}

const queries = [
  ["statement terminator", "SELECT 7 AS value;", "7"],
  ["trailing line comment", "SELECT 7 AS value -- result; stays in the comment", "7"],
  ["quoted semicolon and nested comments", "SELECT 'semi;--text' AS value; /* outer ; /* inner ; */ done */ -- tail", "semi;--text"],
  ["dollar-quoted semicolon", "SELECT $tag$semi;--text$tag$ AS value; -- tail", "semi;--text"],
  ["plain query", "SELECT 7 AS value", "7"],
];

describe.each(["describe", "show", "export"] as const)("%s query boundaries", (operation) => {
  it.each(queries)("accepts a %s without changing its value", async (_name, sql, expected) => {
    expect(await valueFrom(await context(), operation, sql)).toBe(expected);
  });

  it("still refuses a second statement before executing either one", async () => {
    const ctx = await context();
    await ctx.database.run("CREATE TABLE victim AS SELECT 'keep' AS value", { connection });
    await expect(valueFrom(ctx, operation, "SELECT 7 AS value; DELETE FROM victim")).rejects.toMatchObject({ error: { code: "invalid_input" } });
    expect((await ctx.database.run("SELECT value FROM victim", { connection })).rows).toEqual([["keep"]]);
  });
});

it("charts a CTE query with a final terminator and comment", async () => {
  const ctx = await context();
  const sql = "WITH source AS (SELECT * FROM (VALUES (1, 3), (2, 5)) t(category, amount)) SELECT * FROM source; -- plot these rows";
  const result = await showCard(ctx, { kind: "chart", sql, chart: { type: "bar", x: "category", y: "amount", bins: 2 } });
  expect(result.rowCount).toBe(2);
  expect(ctx.sheet.card(result.id)!.sql).toBe(sql);
  const rows = (await ctx.database.run(`SELECT * FROM omb_results.${result.id} ORDER BY x`, { connection })).rows;
  expect(rows.map(([x, x2, y]) => [Number(x), Number(x2), Number(y)])).toEqual([[1, 2, 3], [2, 3, 5]]);
});

it("exports a saved query without a result table when its SQL ends in a comment", async () => {
  const ctx = await context();
  const card = await ctx.sheet.addCard({ kind: "table", title: "Saved query", sql: "SELECT 7 AS value -- saved query", by: "bot" });
  const result = await exportData(ctx, { id: card.id, format: "csv" });
  expect(result.rowCount).toBe(1);
  const rows = (await ctx.database.run(`SELECT value FROM read_csv(${quoteLiteral(result.path)}, delim=',', header=true)`, { connection })).rows;
  expect(rows.map(([value]) => Number(value))).toEqual([7]);
});
