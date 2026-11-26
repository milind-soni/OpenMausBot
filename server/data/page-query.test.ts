// A bot's page reading its bot's database through real DuckDB: one SELECT on the bot's own tables, never a write, a file
// or a URL.
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DATA_RESULTS_SCHEMA } from "../../shared/data-surface.ts";
import { createDataEngine } from "./engine.ts";
import { DataFailure, type BotDatabase, type DataEngine } from "./types.ts";

const root = mkdtempSync(join(tmpdir(), "omb-page-query-"));
const csv = join(root, "secret.csv");
writeFileSync(csv, "token\nhunter2\n");
let engine: DataEngine;
let db: BotDatabase;
const LIMITS = { maxRows: 100, timeoutMs: 5_000 };

beforeAll(async () => {
  engine = createDataEngine({ botFolder: (botId) => join(root, "bots", botId), dataDir: join(root, "data") });
  db = await engine.forBot("scout");
  for (const sql of [
    "CREATE TABLE sales AS SELECT i AS id, ['north', 'south'][1 + i % 2] AS region, (i * 10)::BIGINT AS amount, (i / 4)::DECIMAL(10, 2) AS share FROM range(1, 301) t(i)",
    "CREATE VIEW north AS SELECT * FROM sales WHERE region = 'north'",
    `CREATE TABLE ${DATA_RESULTS_SCHEMA}.r1 AS SELECT 1 AS one`,
    "CREATE SEQUENCE ticket",
    "CREATE MACRO bump() AS nextval('ticket')",
  ]) await db.run(sql, { connection: "bot" });
});

afterAll(async () => {
  await engine.closeAll();
});

async function refused(sql: string, params?: unknown[] | Record<string, unknown>): Promise<DataFailure> {
  try {
    await db.pageQuery(sql, params, LIMITS);
  } catch (error) {
    if (error instanceof DataFailure) return error;
    throw error;
  }
  throw new Error(`ran: ${sql}`);
}

const salesCount = async () => (await db.run("SELECT count(*) FROM sales", { connection: "bot" })).rows[0]![0];

describe("pageQuery", () => {
  it("reads the bot's tables, views and results, with positional and named parameters", async () => {
    const top = await db.pageQuery("SELECT region, sum(amount) AS total FROM sales WHERE id <= ? GROUP BY region ORDER BY region", [10], LIMITS);
    expect(top.columns.map((column) => column.name)).toEqual(["region", "total"]);
    expect(top.rows).toEqual([["north", "300"], ["south", "250"]]);
    expect(top.truncated).toBe(false);
    expect((await db.pageQuery("SELECT count(*) AS n FROM north WHERE amount > $min", { min: 2_000 }, LIMITS)).rows).toEqual([["50"]]);
    expect((await db.pageQuery(`FROM ${DATA_RESULTS_SCHEMA}.r1`, undefined, LIMITS)).rows).toEqual([[1]]);
    expect((await db.pageQuery("WITH recent AS (SELECT * FROM sales WHERE id > 295) SELECT count(*) FROM recent, range(2)", undefined, LIMITS)).rows).toEqual([["10"]]);
    expect((await db.pageQuery("SELECT 1 AS a;", undefined, LIMITS)).rows).toEqual([[1]]);
    expect((await db.pageQuery("WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t WHERE n < 3), u AS (SELECT n FROM t) SELECT sum(n) FROM u", undefined, LIMITS)).rows).toEqual([["6"]]);
  });

  it("stops at maxRows and says the rest was left out", async () => {
    const result = await db.pageQuery("SELECT id FROM sales ORDER BY id", undefined, { maxRows: 7, timeoutMs: 5_000 });
    expect(result.rows).toHaveLength(7);
    expect(result.truncated).toBe(true);
  });

  it("refuses every statement but a SELECT, before it runs", async () => {
    for (const sql of [
      "INSERT INTO sales VALUES (999, 'x', 1, 1)",
      "UPDATE sales SET amount = 0",
      "DELETE FROM sales",
      "WITH gone AS (SELECT 1) DELETE FROM sales",
      "CREATE TABLE copy AS SELECT * FROM sales",
      "DROP TABLE sales",
      `ATTACH '${join(root, "other.duckdb")}' AS other`,
      `COPY sales TO '${join(root, "out.csv")}'`,
      "INSTALL httpfs",
      "LOAD httpfs",
      "SET threads = 1",
      "PRAGMA version",
      "CALL pragma_version()",
      "EXPLAIN SELECT 1",
      "DESCRIBE sales",
      "SELECT 1; DROP TABLE sales",
      "SELECT 1; SELECT 2",
    ]) {
      const failure = await refused(sql);
      expect(failure.error.code, sql).toBe("write_refused");
    }
    expect(await salesCount()).toBe("300");
  });

  it("refuses files, URLs, other databases and settings, without opening the file", async () => {
    for (const sql of [
      `SELECT * FROM read_csv('${csv}')`,
      `SELECT * FROM '${csv}'`,
      `SELECT (SELECT count(*) FROM read_text('${csv}')) AS n`,
      `SELECT * FROM glob('${root}/*')`,
      "SELECT * FROM query('SELECT 1')",
      "SELECT * FROM read_parquet('https://example.com/x.parquet')",
      "SELECT * FROM duckdb_settings()",
      "SELECT current_setting('temp_directory')",
      "SELECT nextval('ticket')",
      "SELECT * FROM information_schema.tables",
      "SELECT * FROM other.main.sales",
      "SELECT * FROM missing_table",
      // A CTE named like a file covers only its own scope, and only a plain name counts as one.
      `SELECT * FROM (WITH "${csv}" AS (SELECT 1) SELECT * FROM "${csv}")`,
      `SELECT * FROM (WITH x AS (SELECT 1) SELECT * FROM x), "${csv}"`,
      "WITH duckdb_databases AS (SELECT * FROM duckdb_databases) SELECT * FROM duckdb_databases",
      "WITH a AS (SELECT * FROM duckdb_databases), duckdb_databases AS (SELECT 1) SELECT * FROM a",
      "WITH RECURSIVE duckdb_databases AS (SELECT * FROM duckdb_databases UNION ALL SELECT 1) SELECT 1",
    ]) {
      const failure = await refused(sql);
      expect(failure.error.code, sql).toBe("write_refused");
      expect(failure.error.message, sql).not.toContain("hunter2");
    }
  });

  it("runs read-only: a macro that would write is stopped by DuckDB itself", async () => {
    const failure = await refused("SELECT bump()");
    expect(failure.error.code).toBe("sql_error");
    expect(failure.error.message).toMatch(/read-only/);
    expect((await db.run("SELECT currval('ticket')", { connection: "bot" }).catch(() => null))?.rows ?? null).toBeNull();
  });

  it("stops a query at its time limit and the next one runs", async () => {
    const failure = await db.pageQuery("SELECT count(*) FROM range(100000000) x, range(100000000) y", undefined, { maxRows: 1, timeoutMs: 300 }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DataFailure);
    expect((failure as DataFailure).error.code).toBe("timeout");
    expect((await db.pageQuery("SELECT count(*) FROM sales", undefined, LIMITS)).rows).toEqual([["300"]]);
  }, 30_000);
});
