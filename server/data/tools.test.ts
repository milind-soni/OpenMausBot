// The Data tools against a fake database: the statement gate, bounds by
// rows and bytes, load planning with quoted literals and stripped
// credentials, cards that update in place and fail honestly, export paths
// confined to the allowed folders, and the error shape of every refusal.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DATA_LIMITS, DATA_TOOL_NAMES, type DataColumn } from "../../shared/data-surface.ts";
import { FakeDataDatabase } from "../testing/fake-data-database.ts";
import { DataSheetStore } from "./sheet.ts";
import {
  DATA_TOOLS,
  boundColumns,
  boundRows,
  classifySql,
  dataToolCallProblem,
  exportData,
  loadData,
  planLoad,
  resolveExportPath,
  runDataTool,
  runSql,
  showCard,
  stripCredentials,
  tableNameFrom,
  toDataError,
  type DataContext,
} from "./tools.ts";
import { DataFailure } from "./types.ts";

const dirs: string[] = [];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-data-tools-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function context(overrides: Partial<DataContext> = {}) {
  const dir = freshDir();
  const database = new FakeDataDatabase();
  const sheet = new DataSheetStore({ botId: "bot-1", dir: join(dir, "sheet"), dropResult: (name) => database.dropResult(name) });
  const rendered: string[] = [];
  const ctx: DataContext = {
    database,
    sheet,
    compileChart: (spec, columns, from) => ({
      sql: `SELECT ${spec.x}, count(*) AS n FROM ${from} GROUP BY ALL`,
      vegaLite: { mark: spec.type, encoding: { x: { field: spec.x }, y: { field: "n" } }, columns: columns.map((column) => column.name) },
      reduction: { method: "group" },
    }),
    validateVegaLite: async (spec) => {
      if (!spec || typeof spec !== "object" || !("mark" in spec)) throw new DataFailure({ code: "spec_invalid", message: "A Vega-Lite spec needs a mark." });
      return { ...(spec as Record<string, unknown>), validated: true };
    },
    renderer: {
      svg: async (_spec, rows) => { rendered.push("svg"); return `<svg>${rows.length}</svg>`; },
      png: async (_spec, rows) => { rendered.push("png"); return Buffer.from(`png:${rows.length}`); },
    },
    exportRoots: () => [join(dir, "work"), join(dir, "Downloads")],
    signal: new AbortController().signal,
    connection: "bot",
    by: "bot",
    ...overrides,
  };
  mkdirSync(join(dir, "work"), { recursive: true });
  mkdirSync(join(dir, "Downloads"), { recursive: true });
  return { ctx, database, sheet, dir, rendered };
}

const failure = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { if (error instanceof DataFailure) return error.error; throw error; }
  throw new Error("expected a DataFailure");
};

describe("the catalog", () => {
  it("lists the five tools in the shared order, each with a schema Ajv compiles", () => {
    expect(DATA_TOOLS.map((tool) => tool.name)).toEqual([...DATA_TOOL_NAMES]);
    expect(dataToolCallProblem("data_sql", { sql: "SELECT 1" })).toBeNull();
    expect(dataToolCallProblem("data_sql", { sql: "SELECT 1", limit: 5000 })).toContain("limit");
    expect(dataToolCallProblem("data_show", { kind: "chart", sql: "SELECT 1", chart: { type: "bar" } })).toContain("x");
    expect(dataToolCallProblem("data_show", { kind: "table", sql: "SELECT 1", extra: 1 })).toContain("extra");
    expect(dataToolCallProblem("data_drop", {})).toContain("Unknown Data tool");
    expect(dataToolCallProblem("data_load", { source: "a.csv", options: { delimiter: "" } })).toContain("delimiter");
    expect(dataToolCallProblem("data_describe", {})).toBeNull();
    expect(dataToolCallProblem("data_describe", { id: "c_1" })).toBeNull();
    expect(dataToolCallProblem("data_show", { id: "c_1", sql: "SELECT 2" })).toBeNull();
  });
});

describe("the statement gate", () => {
  it.each([
    ["SELECT 1", { kind: "read", materialisable: true }],
    ["  select * from t;  ", { kind: "read", materialisable: true }],
    ["WITH a AS (SELECT 1) SELECT * FROM a", { kind: "read", materialisable: true }],
    ["WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t WHERE n < 3) SELECT * FROM t", { kind: "read", materialisable: true }],
    ["WITH a AS MATERIALIZED (SELECT 1), b AS (SELECT 2) FROM b", { kind: "read", materialisable: true }],
    ["FROM t", { kind: "read", materialisable: true }],
    ["PIVOT t ON x USING sum(y)", { kind: "read", materialisable: true }],
    ["VALUES (1), (2)", { kind: "read", materialisable: true }],
    ["DESCRIBE t", { kind: "read", materialisable: false }],
    ["SUMMARIZE t", { kind: "read", materialisable: false }],
    ["SHOW TABLES", { kind: "read", materialisable: false }],
    ["EXPLAIN SELECT 1", { kind: "read", materialisable: false }],
    ["EXPLAIN ANALYZE SELECT 1", { kind: "read", materialisable: false }],
    // column names and aliases are never verbs
    ["SELECT comment, load, \"set\", copy AS attach FROM t", { kind: "read", materialisable: true }],
    ["SELECT ';' AS semi, 'DROP TABLE t' AS s FROM t -- ; DELETE", { kind: "read", materialisable: true }],
    ["SELECT \"a;b\" FROM t /* ; INSERT */", { kind: "read", materialisable: true }],
    ["SELECT $$x;y$$", { kind: "read", materialisable: true }],
    ["CREATE TABLE x AS SELECT 1", { kind: "create", target: "x" }],
    ["CREATE OR REPLACE TABLE s.x AS SELECT 1", { kind: "create", target: "s.x" }],
    ["create or replace view \"My View\" as select 1", { kind: "create", target: "\"My View\"" }],
    ["CREATE TEMP TABLE IF NOT EXISTS t2(a, b) AS SELECT 1, 2", { kind: "create", target: "t2" }],
    ["CREATE TABLE s.\"T\" AS FROM t", { kind: "create", target: "s.\"T\"" }],
  ])("classifies %s", (sql, expected) => {
    expect(classifySql(sql)).toEqual(expected);
  });

  it.each([
    "INSERT INTO t VALUES (1)", "UPDATE t SET a = 1", "DELETE FROM t", "DROP TABLE t", "ALTER TABLE t ADD COLUMN x INT",
    "SET threads = 1", "PRAGMA memory_limit = '1GB'", "ATTACH 'x.db' AS x", "COPY t TO 'out.csv'", "CALL something()",
    "INSTALL httpfs", "LOAD httpfs", "CREATE TABLE t (a INT)", "CREATE SCHEMA s", "CREATE INDEX i ON t(a)",
    "WITH a AS (SELECT 1) DELETE FROM t", "WITH a(x) AS (SELECT 1) INSERT INTO t SELECT * FROM a", "EXPLAIN ANALYZE DELETE FROM t",
    "BEGIN", "EXPORT DATABASE 'd'", "TRUNCATE t",
  ])("refuses %s", (sql) => {
    expect(classifySql(sql).kind).toBe("refused");
  });

  it("refuses two statements and unterminated quotes as invalid input", async () => {
    expect(await failure(Promise.resolve().then(() => classifySql("SELECT 1; SELECT 2")))).toMatchObject({ code: "invalid_input", message: "One statement per call." });
    expect(classifySql("SELECT 1;; ")).toEqual({ kind: "read", materialisable: true });
    expect(await failure(Promise.resolve().then(() => classifySql("SELECT 'oops")))).toMatchObject({ code: "invalid_input" });
    expect(await failure(Promise.resolve().then(() => classifySql("   ")))).toMatchObject({ code: "invalid_input" });
    expect(classifySql("SELECT 1;")).toEqual({ kind: "read", materialisable: true });
  });
});

describe("bounds", () => {
  it("cuts rows to the limit, then to the byte budget, and marks the result truncated", () => {
    const rows = Array.from({ length: 10 }, (_, i) => [i, "x".repeat(100)]);
    expect(boundRows(rows, 10, 1_000_000)).toEqual({ rows, truncated: false });
    expect(boundRows(rows, 4, 1_000_000).rows).toHaveLength(4);
    expect(boundRows(rows, 4, 1_000_000).truncated).toBe(true);
    const byBytes = boundRows(rows, 10, 500);
    expect(byBytes.truncated).toBe(true);
    expect(byBytes.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(byBytes.rows).length).toBeLessThanOrEqual(500);
    const wide = boundRows([[ "y".repeat(5000) ]], 10, 1_000_000);
    expect((wide.rows[0]![0] as string).length).toBe(2001);
  });

  it("keeps types only past the column cap and sheds statistics to fit the byte budget", () => {
    const many: DataColumn[] = Array.from({ length: DATA_LIMITS.describeColumnsMax + 1 }, (_, i) => ({ name: `c${i}`, type: "INTEGER", nullPct: 0, sample: ["1"] }));
    const typesOnly = boundColumns(many, 1_000_000);
    expect(typesOnly.truncated).toBe(true);
    expect(typesOnly.columns[0]).toEqual({ name: "c0", type: "INTEGER" });
    const few: DataColumn[] = [{ name: "a", type: "VARCHAR", min: "a", max: "z", sample: ["1", "2", "3", "4", "x".repeat(60)] }];
    const trimmed = boundColumns(few, 1_000_000);
    expect(trimmed.columns[0]!.sample).toEqual(["1", "2", "3"]);
    expect(boundColumns([{ name: "a", type: "VARCHAR", min: "a", max: "z", sample: ["1234567890"] }], 60).columns[0]).toEqual({ name: "a", type: "VARCHAR", min: "a", max: "z" });
  });
});

describe("sources", () => {
  it("strips credentials from connection strings and signed URLs", () => {
    expect(stripCredentials("postgres://alice:s3cret@db.example.com:5432/shop")).toBe("postgres://alice@db.example.com:5432/shop");
    expect(stripCredentials("host=db user=alice password=s3cret dbname=shop")).toBe("host=db user=alice password=*** dbname=shop");
    expect(stripCredentials("https://example.com/data.csv?token=abc&x=1")).toBe("https://example.com/data.csv?token=***&x=1");
    expect(stripCredentials("s3://bucket/key.parquet?X-Amz-Signature=deadbeef")).toContain("X-Amz-Signature=***");
    expect(stripCredentials("/Users/me/orders.csv")).toBe("/Users/me/orders.csv");
  });

  it("derives table names that DuckDB accepts", () => {
    expect(tableNameFrom("Sales Report 2024")).toBe("sales_report_2024");
    expect(tableNameFrom("2024-sales")).toBe("t_2024_sales");
    expect(tableNameFrom("")).toBe("data");
    expect(tableNameFrom("x".repeat(100))).toHaveLength(63);
  });

  it("plans readers with quoted literals for files, globs, folders, workbooks and sheets", () => {
    const dir = freshDir();
    writeFileSync(join(dir, "it's.csv"), "a,b\n1,2\n");
    writeFileSync(join(dir, "data.tsv"), "a\tb\n1\t2\n");
    writeFileSync(join(dir, "book.xlsx"), "");
    writeFileSync(join(dir, "events.ndjson.gz"), "");
    const csv = planLoad({ source: join(dir, "it's.csv"), options: { delimiter: "'" } });
    expect(csv).toHaveLength(1);
    expect(csv[0]).toMatchObject({ kind: "csv", stem: "it's" });
    expect(csv[0]!.reader).toBe(`read_csv('${join(dir, "it''s.csv")}', delim='''')`);
    expect(planLoad({ source: join(dir, "data.tsv") })[0]!.reader).toBe(`read_csv('${join(dir, "data.tsv")}', delim='\t')`);
    expect(planLoad({ source: join(dir, "events.ndjson.gz") })[0]).toMatchObject({ kind: "json", stem: "events", reader: `read_json_auto('${join(dir, "events.ndjson.gz")}')` });
    const book = planLoad({ source: join(dir, "book.xlsx"), sheet: "Q1" })[0]!;
    expect(book).toMatchObject({ kind: "xlsx", stem: "book_Q1", reader: `read_xlsx('${join(dir, "book.xlsx")}', sheet='Q1')`, warnings: [] });
    expect(planLoad({ source: join(dir, "book.xlsx") })[0]!.warnings[0]).toContain("first sheet");
    const glob = planLoad({ source: join(dir, "*.parquet") })[0]!;
    expect(glob).toMatchObject({ kind: "folder" });
    expect(glob.reader).toBe(`read_parquet('${join(dir, "*.parquet")}', union_by_name=true, filename=true)`);
    // a folder: one table per file family, globs with forward slashes, no braces
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "more.parquet"), "");
    writeFileSync(join(dir, "nested", "legacy.txt"), "a,b\n");
    const folder = planLoad({ source: dir, name: "stuff" });
    expect(folder.map((plan) => plan.stem).sort()).toEqual(["stuff_csv", "stuff_json", "stuff_parquet", "stuff_tsv"]);
    const csvFamily = folder.find((plan) => plan.stem === "stuff_csv")!.reader;
    const forward = dir.replace(/\\/g, "/");
    expect(csvFamily).toBe(`read_csv(['${forward}/**/*.csv', '${forward}/**/*.txt'], union_by_name=true, filename=true)`);
    expect(folder.find((plan) => plan.stem === "stuff_parquet")!.reader).toBe(`read_parquet('${forward}/**/*.parquet', union_by_name=true, filename=true)`);
    expect(folder.find((plan) => plan.stem === "stuff_tsv")!.reader).toContain("delim='\t'");
  });

  it("plans URLs, Google Sheets, databases, and refuses what it cannot read", () => {
    expect(planLoad({ source: "https://example.com/files/Sales.csv?token=abc" })[0]).toMatchObject({ kind: "url", stem: "Sales", source: "https://example.com/files/Sales.csv?token=***", reader: "read_csv('https://example.com/files/Sales.csv?token=abc')" });
    expect(planLoad({ source: "s3://bucket/part-*.parquet" })[0]!.reader).toBe("read_parquet('s3://bucket/part-*.parquet')");
    const sheet = planLoad({ source: "https://docs.google.com/spreadsheets/d/1AbC_d-e/edit#gid=42" })[0]!;
    expect(sheet).toMatchObject({ kind: "gsheet", reader: "read_csv('https://docs.google.com/spreadsheets/d/1AbC_d-e/export?format=csv&gid=42')" });
    expect(sheet.warnings[0]).toContain("CSV export");
    const pg = planLoad({ source: "postgresql://bob:hunter2@db:5432/shop", sheet: "public.orders" })[0]!;
    expect(pg).toMatchObject({ kind: "postgres", source: "postgresql://bob@db:5432/shop", attach: { type: "postgres", connection: "postgresql://bob:hunter2@db:5432/shop", table: "public.orders" } });
    expect(planLoad({ source: "mysql://u:p@h/db" })[0]).toMatchObject({ kind: "mysql", source: "mysql://u@h/db" });
    expect(() => planLoad({ source: "https://example.com/report" })).toThrow(DataFailure);
    expect(() => planLoad({ source: join(freshDir(), "missing.csv") })).toThrow(expect.objectContaining({ error: expect.objectContaining({ code: "source_not_found" }) }));
    const dir = freshDir();
    writeFileSync(join(dir, "notes.foo"), "");
    expect(() => planLoad({ source: join(dir, "notes.foo") })).toThrow(expect.objectContaining({ error: expect.objectContaining({ code: "source_unsupported" }) }));
    expect(planLoad({ source: join(dir, "notes.foo"), kind: "csv" })[0]!.kind).toBe("csv");
  });

  it("names the remote filesystem and workbook extensions the reader needs", () => {
    expect(planLoad({ source: "https://example.com/data.csv" })[0]!.extensions).toEqual(["httpfs"]);
    expect(planLoad({ source: "s3://bucket/data.parquet" })[0]!.extensions).toEqual(["httpfs"]);
    expect(planLoad({ source: "az://container/data.parquet" })[0]!.extensions).toEqual(["azure"]);
    expect(planLoad({ source: "https://example.com/book.xlsx" })[0]!.extensions).toEqual(["httpfs", "excel"]);
    expect(planLoad({ source: "https://docs.google.com/spreadsheets/d/book/edit" })[0]!.extensions).toEqual(["httpfs"]);
    const path = join(freshDir(), "book.xlsx");
    writeFileSync(path, "");
    expect(planLoad({ source: path })[0]!.extensions).toEqual(["excel"]);
  });
});

describe("data_load", () => {
  it("passes required extensions to the engine for load, attachment, and export", async () => {
    const { ctx, database } = context();
    const requirements: unknown[] = [];
    database.onRun = (_sql, options) => { if (options.extensions?.length) requirements.push(options.extensions); return undefined; };
    await loadData(ctx, { source: "https://example.com/data.csv" });
    await loadData(ctx, { source: "https://example.com/book.xlsx" });
    await loadData(ctx, { source: "postgres://db/shop", sheet: "orders" });
    await exportData(ctx, { sql: "SELECT 1", format: "xlsx" });
    expect(requirements).toEqual([["httpfs"], ["httpfs", "excel"], ["postgres"], ["excel"]]);
  });

  it("creates the table, describes it and records the source", async () => {
    const { ctx, database, sheet } = context();
    const dir = freshDir();
    writeFileSync(join(dir, "Orders 2024.csv"), "id,name\n1,one\n");
    const out = await loadData(ctx, { source: join(dir, "Orders 2024.csv") });
    expect(database.calls.filter((call) => call.method === "run").map((call) => call.sql)).toEqual([
      `CREATE OR REPLACE TABLE "orders_2024" AS SELECT * FROM read_csv('${join(dir, "Orders 2024.csv")}')`,
    ]);
    expect(out.tables).toHaveLength(1);
    expect(out.tables[0]).toMatchObject({ name: "orders_2024", rowCount: 3, source: join(dir, "Orders 2024.csv") });
    expect(out.tables[0]!.columns[0]!.sample).toEqual(["1", "2", "3"]);
    expect(sheet.sheet().sources[0]).toMatchObject({ name: "orders_2024", kind: "csv", rowCount: 3 });
    // replace:false keeps the existing table and loads beside it
    const again = await loadData(ctx, { source: join(dir, "Orders 2024.csv"), replace: false });
    expect(again.tables[0]!.name).toBe("orders_2024_2");
    expect(database.calls.at(-2)!.sql).toMatch(/^CREATE TABLE "orders_2024_2"/);
  });

  it("snapshots a database read-only, detaches it even on failure, and never records the password", async () => {
    const { ctx, database, sheet } = context();
    const out = await loadData(ctx, { source: "postgres://bob:hunter2@db/shop" });
    const sqls = database.calls.filter((call) => call.method === "run").map((call) => call.sql!);
    expect(sqls[0]).toMatch(/^ATTACH 'postgres:\/\/bob:hunter2@db\/shop' AS "omb_src_\w+" \(TYPE postgres, READ_ONLY\)$/);
    expect(sqls[1]).toContain("duckdb_tables()");
    expect(sqls[2]).toMatch(/^CREATE OR REPLACE TABLE "orders" AS SELECT \* FROM "omb_src_\w+"\."public"\."orders"$/);
    expect(sqls[3]).toMatch(/^CREATE OR REPLACE TABLE "people" AS/);
    expect(sqls[4]).toMatch(/^DETACH "omb_src_\w+"$/);
    expect(out.tables.map((table) => table.name)).toEqual(["orders", "people"]);
    expect(JSON.stringify(sheet.sheet().sources)).not.toContain("hunter2");
    expect(sheet.sheet().sources[0]).toMatchObject({ kind: "postgres", source: "postgres://bob@db/shop", options: { table: "public.orders" } });

    database.calls.length = 0;
    database.onRun = (sql) => { if (sql.startsWith("CREATE")) throw new DataFailure({ code: "sql_error", message: "Catalog Error: Table with name nope does not exist!" }); return undefined; };
    const refused = await failure(loadData(ctx, { source: "postgres://bob:hunter2@db/shop", sheet: "public.nope", name: "n" }));
    expect(refused.code).toBe("sql_error");
    const after = database.calls.filter((call) => call.method === "run").map((call) => call.sql!);
    expect(after.map((sql) => sql.split(" ")[0])).toEqual(["ATTACH", "CREATE", "DETACH"]);
    expect(after[1]).toMatch(/^CREATE OR REPLACE TABLE "n" AS SELECT \* FROM "omb_src_\w+"\."public"\."nope"$/);
  });
});

describe("data_describe saved results", () => {
  it("reads the latest saved SQL after a person edits it, without rerunning queries", async () => {
    const { ctx, database, sheet } = context();
    await showCard(ctx, { kind: "table", sql: "SELECT 1", title: "First" });
    await showCard(ctx, { kind: "table", sql: "SELECT 2", title: "Second" });
    sheet.card("c_2")!.updatedAt = "2020-01-01T00:00:00.000Z";
    await showCard({ ...ctx, by: "person", connection: "panel" }, { id: "c_1", sql: "SELECT 3 AS edited", live: true });
    sheet.recordTable({ name: "Order Details", sqlName: '"Order Details"', rowCount: 3, columns: [] });
    database.calls.length = 0;
    const read = await runDataTool(ctx, "data_describe", {});
    expect(read.structuredContent).toMatchObject({
      card: { id: "c_1", title: "First", kind: "table", sql: "SELECT 3 AS edited", by: "person", status: "ready" },
      cards: [{ id: "c_1" }, { id: "c_2" }], tables: [{ name: "Order Details", sqlName: '"Order Details"', rowCount: 3 }],
      truncated: false, omitted: [],
    });
    expect(database.calls).toEqual([]);
    const explicit = await runDataTool(ctx, "data_describe", { id: "c_2" });
    expect(explicit.structuredContent).toMatchObject({ card: { id: "c_2", sql: "SELECT 2" } });
  });

  it("reads the original chart or raw Vega-Lite spec needed for an edit", async () => {
    const { ctx } = context();
    const chart = { type: "bar" as const, x: "region" };
    await showCard(ctx, { kind: "chart", sql: "SELECT region FROM orders", chart });
    const simple = (await runDataTool(ctx, "data_describe", { id: "c_1" })).structuredContent!.card;
    expect(simple).toMatchObject({ kind: "chart", sql: "SELECT region FROM orders", chart });
    expect(simple).not.toHaveProperty("vegaLite");
    await showCard(ctx, { kind: "chart", sql: "SELECT 2", vegaLite: { mark: "line" } });
    const raw = (await runDataTool(ctx, "data_describe", { id: "c_2" })).structuredContent!.card;
    expect(raw).toMatchObject({ kind: "chart", vegaLite: { mark: "line", validated: true } });
    expect(raw).not.toHaveProperty("chart");
  });

  it("keeps saved-state output byte bounded and never returns partial SQL or source credentials", async () => {
    const { ctx, sheet, database } = context();
    const sql = `SELECT '${"private-long-value".repeat(3000)}'`;
    await sheet.addCard({ kind: "chart", title: "Large", sql, vegaLite: { description: "x".repeat(20_000) }, by: "person" });
    for (let index = 0; index < 100; index++) sheet.recordSource({ name: `table_${index}_${"x".repeat(180)}`, kind: "postgres", source: "postgres://user:source-secret@host/db", rowCount: 1, columns: [], loadedAt: "2026-01-01" });
    const result = await runDataTool(ctx, "data_describe", { id: "c_1" });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ truncated: true, omitted: ["sql", "vegaLite"] });
    expect(result.structuredContent!.card).not.toHaveProperty("sql");
    expect(Buffer.byteLength(result.content[0]!.text)).toBeLessThanOrEqual(DATA_LIMITS.describeBytesMax);
    expect(result.content[0]!.text).not.toContain("source-secret");
    expect(database.calls).toEqual([]);
  });

  it("handles empty state and refuses unknown or conflicting targets without leaking input", async () => {
    const { ctx, database } = context();
    expect((await runDataTool(ctx, "data_describe", {})).structuredContent).toMatchObject({ card: null, cards: [], tables: [] });
    expect((await runDataTool(ctx, "data_describe", { id: "c_999" })).structuredContent).toMatchObject({ code: "card_not_found" });
    const conflicting = await runDataTool(ctx, "data_describe", { id: "c_1", target: "SELECT 'secret-target'" });
    expect(conflicting.structuredContent).toMatchObject({ code: "invalid_input" });
    expect(conflicting.content[0]!.text).not.toContain("secret-target");
    expect(database.calls).toEqual([]);
  });
});

describe("data_sql", () => {
  it("materialises a SELECT into omb_results.q_<n> and returns bounded rows", async () => {
    const { ctx, database } = context();
    database.next = { rows: [[1, "a"], [2, "b"], [3, "c"], [4, "d"], [5, "e"]], rowCount: 5 };
    const out = await runSql(ctx, { sql: "SELECT * FROM t", limit: 2 });
    expect(database.calls.find((call) => call.method === "materialise")).toMatchObject({ sql: "SELECT * FROM t", name: "q_1", connection: "bot" });
    expect(database.calls.at(-1)).toMatchObject({ method: "run", sql: "SELECT * FROM omb_results.q_1 LIMIT 3", maxRows: 3 });
    expect(out).toMatchObject({ table: "omb_results.q_1", rowCount: 5, rows: [[1, "a"], [2, "b"]], truncated: true });
    const named = await runSql(ctx, { sql: "SELECT 1", name: "My Totals" });
    expect(named.table).toBe("omb_results.my_totals");
  });

  it("bounds by bytes as well as rows", async () => {
    const { ctx, database } = context();
    const rows = Array.from({ length: 50 }, (_, i) => [i, "z".repeat(1500)]);
    database.next = { rows, rowCount: 50 };
    const out = await runSql(ctx, { sql: "SELECT * FROM wide", limit: 50 });
    expect(out.truncated).toBe(true);
    expect(out.rows.length).toBeLessThan(50);
    expect(JSON.stringify(out.rows).length).toBeLessThanOrEqual(DATA_LIMITS.sqlBytesMax);
  });

  it("runs CREATE … AS and metadata statements directly", async () => {
    const { ctx, database } = context();
    const created = await runSql(ctx, { sql: "CREATE OR REPLACE TABLE paid AS SELECT * FROM orders WHERE paid" });
    expect(database.calls.map((call) => call.method)).toEqual(["run", "describe"]);
    expect(database.calls[1]!.target).toBe("paid");
    expect(created).toMatchObject({ table: "paid", rows: [], truncated: false, rowCount: 3 });
    database.calls.length = 0;
    const described = await runSql(ctx, { sql: "DESCRIBE orders" });
    expect(database.calls.map((call) => call.method)).toEqual(["run"]);
    expect(described.table).toBeNull();
    expect(described.rows).toHaveLength(3);
  });

  it("refuses writes and passes DuckDB's own text through with the line and a hint", async () => {
    const { ctx, database } = context();
    const refused = await runDataTool(ctx, "data_sql", { sql: "DELETE FROM orders" });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({ code: "write_refused", message: "DELETE is not allowed here.", sql: "DELETE FROM orders" });
    expect(refused.content[0]!.text).toContain("write_refused");
    expect(database.calls).toEqual([]);

    database.failNext = new Error('Binder Error: Referenced column "amount" not found in FROM clause!\nLINE 1: SELECT amount FROM orders\n               ^');
    const bound = await runDataTool(ctx, "data_sql", { sql: "SELECT amount FROM orders" });
    expect(bound.structuredContent).toMatchObject({ code: "sql_error", line: 1, sql: "SELECT amount FROM orders", hint: "Check column names with data_describe." });
    expect((bound.structuredContent as { message: string }).message).toMatch(/^Binder Error: Referenced column/);

    const two = await runDataTool(ctx, "data_sql", { sql: "SELECT 1; DROP TABLE orders" });
    expect(two.structuredContent).toMatchObject({ code: "invalid_input" });
  });

  it("reports a cancelled statement as cancelled", async () => {
    const abort = new AbortController();
    const { ctx, database } = context({ signal: abort.signal });
    database.delayMs = 50;
    const pending = runDataTool(ctx, "data_sql", { sql: "SELECT * FROM slow" });
    abort.abort();
    expect((await pending).structuredContent).toMatchObject({ code: "cancelled" });
    expect(toDataError(new Error("INTERRUPT Error: Interrupted!"), "SELECT 1")).toMatchObject({ code: "cancelled", sql: "SELECT 1" });
    expect(toDataError(new Error("Query timed out after 60s"))).toMatchObject({ code: "timeout", retryable: true });
  });
});

describe("data_show", () => {
  it("adds a table card that runs, then is ready with its result table", async () => {
    const { ctx, database, sheet } = context();
    database.next = { rowCount: 12 };
    const out = await showCard(ctx, { kind: "table", sql: "SELECT * FROM orders", title: "Orders" });
    expect(out).toMatchObject({ id: "c_1", rowCount: 12, sheet: [{ id: "c_1", title: "Orders", kind: "table" }], warnings: [] });
    const card = sheet.card("c_1")!;
    expect(card).toMatchObject({ status: "ready", result: "c_1", rowCount: 12, truncated: false, by: "bot", sql: "SELECT * FROM orders" });
    expect(card.columns).toHaveLength(2);
    expect(database.calls.find((call) => call.method === "materialise")).toMatchObject({ sql: `SELECT * FROM (SELECT * FROM orders) LIMIT ${DATA_LIMITS.showTableRowsMax}`, name: "c_1" });
  });

  it("points a card at a loaded table through resolveTable", async () => {
    const { ctx, database, sheet } = context();
    database.tables.set("Orders", { columns: [{ name: "id", type: "INTEGER" }], rows: [[1]] });
    await showCard(ctx, { kind: "table", table: "orders" });
    expect(sheet.card("c_1")).toMatchObject({ title: "orders", sql: 'SELECT * FROM "Orders"' });
    expect(await failure(showCard(ctx, { kind: "table", table: "nothing" }))).toMatchObject({ code: "table_not_found", candidates: ["Orders"] });
  });

  it("updates an existing card in place and keeps the last good result when the new query fails", async () => {
    const { ctx, database, sheet } = context();
    await showCard(ctx, { kind: "table", sql: "SELECT 1", title: "First" });
    await showCard(ctx, { kind: "table", sql: "SELECT 2", title: "Second" });
    database.next = { rowCount: 7 };
    const out = await showCard(ctx, { id: "c_1", kind: "table", sql: "SELECT 1 WHERE true" });
    expect(out.id).toBe("c_1");
    expect(sheet.cards().map((card) => card.id)).toEqual(["c_1", "c_2"]);
    expect(sheet.card("c_1")).toMatchObject({ title: "First", sql: "SELECT 1 WHERE true", rowCount: 7, status: "ready" });
    const goodResult = sheet.card("c_1")!.result;

    database.failNext = new Error("Parser Error: syntax error at or near \"FORM\"");
    const failed = await failure(showCard(ctx, { id: "c_1", kind: "table", sql: "SELECT 1 FORM t" }));
    expect(failed).toMatchObject({ code: "sql_error", sql: "SELECT 1 FORM t" });
    expect(sheet.card("c_1")).toMatchObject({ status: "ready", result: goodResult, rowCount: 7, sql: "SELECT 1 WHERE true" });
    expect(sheet.card("c_1")?.error).toBeUndefined();
    expect(await failure(showCard(ctx, { id: "c_9", kind: "table", sql: "SELECT 1" }))).toMatchObject({ code: "card_not_found" });
  });

  it("drops a replaced or abandoned result on the caller's connection, never behind the bot's", async () => {
    const { ctx, database } = context({ by: "person", connection: "panel" });
    await showCard(ctx, { kind: "table", sql: "SELECT 1" });
    await showCard(ctx, { id: "c_1", kind: "table", sql: "SELECT 2", live: true });
    database.failNext = new Error("Parser Error: syntax error at or near \"FORM\"");
    await failure(showCard(ctx, { id: "c_1", kind: "table", sql: "SELECT 3 FORM t", live: true }));
    const drops = database.calls.filter((call) => call.method === "dropResult");
    expect(drops.map((call) => call.connection)).toEqual(["panel", "panel"]);
    expect(drops[0]!.name).toBe("c_1");
    expect(drops[1]!.name).toMatch(/^c_1_/);
  });

  it("publishes only the latest live edit even when older materialisation ignores cancellation", async () => {
    const { ctx, database, sheet } = context({ by: "person", connection: "panel" });
    await showCard(ctx, { kind: "table", sql: "SELECT 1" });
    const original = database.materialise.bind(database);
    const started = deferred();
    const release = deferred();
    let oldSignal: AbortSignal | undefined;
    database.materialise = async (sql, name, options) => {
      if (sql.includes("SELECT 2")) {
        oldSignal = options.signal;
        started.resolve();
        await release.promise;
        database.next = { rows: [[2]] };
        return original(sql, name, { ...options, signal: undefined });
      }
      database.next = { rows: [[3]] };
      return original(sql, name, options);
    };
    const stale = failure(showCard(ctx, { id: "c_1", kind: "table", sql: "SELECT 2", live: true }));
    await started.promise;
    expect(sheet.card("c_1")).toMatchObject({ sql: "SELECT 1", result: "c_1", status: "ready" });
    await showCard(ctx, { id: "c_1", kind: "table", sql: "SELECT 3", live: true });
    const latest = sheet.card("c_1")!;
    expect(oldSignal?.aborted).toBe(true);
    expect(latest).toMatchObject({ sql: "SELECT 3", status: "ready" });
    release.resolve();
    expect(await stale).toMatchObject({ code: "cancelled" });
    expect(sheet.card("c_1")).toBe(latest);
    expect([...database.results.keys()]).toEqual([latest.result]);
    expect(database.results.get(latest.result!)!.rows).toEqual([[3]]);
  });

  it("an empty live edit cancels the prior query without changing the last good card", async () => {
    const { ctx, database, sheet } = context({ by: "person", connection: "panel" });
    await showCard(ctx, { kind: "table", sql: "SELECT 1" });
    const good = sheet.card("c_1");
    database.delayMs = 30;
    const previous = failure(showCard(ctx, { id: "c_1", kind: "table", sql: "SELECT 2", live: true }));
    expect(await failure(showCard(ctx, { id: "c_1", kind: "table", sql: "", live: true }))).toMatchObject({ code: "invalid_input" });
    expect(await previous).toMatchObject({ code: "cancelled" });
    expect(sheet.card("c_1")).toBe(good);
    expect([...database.results.keys()]).toEqual(["c_1"]);
  });

  it("restores the last good status when a live draft supersedes a non-live rerun", async () => {
    const { ctx, database, sheet } = context({ by: "person", connection: "panel" });
    await showCard(ctx, { kind: "table", sql: "SELECT 1" });
    const good = sheet.card("c_1")!;
    database.delayMs = 30;
    const previous = failure(showCard(ctx, { id: "c_1", kind: "table", sql: "SELECT 2" }));
    expect(sheet.card("c_1")?.status).toBe("running");
    expect(await failure(showCard({ ...ctx, by: "person" }, { id: "c_1", kind: "table", sql: "", live: true }))).toMatchObject({ code: "invalid_input" });
    expect(await previous).toMatchObject({ code: "cancelled" });
    expect(sheet.card("c_1")).toMatchObject({ status: "ready", sql: good.sql, result: good.result, by: good.by });
    expect(sheet.card("c_1")?.error).toBeUndefined();
    expect([...database.results.keys()]).toEqual([good.result]);
  });

  it("keeps the last good chart when validation fails after a replacement table was built", async () => {
    const { ctx, database, sheet } = context({ by: "person", connection: "panel" });
    const chart = { type: "scatter" as const, x: "id", y: "name" };
    await showCard(ctx, { kind: "chart", sql: "SELECT * FROM orders", chart });
    const good = sheet.card("c_1")!;
    const rows = database.results.get(good.result!)!.rows;
    database.next = { rowCount: DATA_LIMITS.chartMaxMarks + 1, rows: [["oversized"]] };
    const failed = await failure(showCard(ctx, { id: "c_1", kind: "chart", sql: "SELECT * FROM too_many", chart, live: true }));
    expect(failed).toMatchObject({ code: "output_too_large" });
    expect(sheet.card("c_1")).toBe(good);
    expect(database.results.get(good.result!)!.rows).toBe(rows);
    expect([...database.results.keys()]).toEqual([good.result]);
  });

  it("compiles a chart spec, materialises the reduction and records it on the card", async () => {
    const { ctx, database, sheet } = context();
    database.next = { columns: [{ name: "region", type: "VARCHAR" }, { name: "n", type: "BIGINT" }], rows: [["eu", 3], ["us", 5]], rowCount: 2 };
    const out = await showCard(ctx, { kind: "chart", sql: "SELECT * FROM orders", chart: { type: "bar", x: "region" } });
    expect(out.reduction).toEqual({ method: "group", inputRows: 1234, outputRows: 2 });
    const card = sheet.card("c_1")!;
    expect(card).toMatchObject({ kind: "chart", title: "bar of count by region", status: "ready", result: "c_1", chart: { type: "bar", x: "region" }, vegaLite: { mark: "bar", columns: ["region", "n"] } });
    const materialised = database.calls.find((call) => call.method === "materialise")!;
    expect(materialised.sql).toBe("SELECT region, count(*) AS n FROM (SELECT * FROM orders) GROUP BY ALL");
    expect(database.calls.some((call) => call.sql === "SELECT * FROM (SELECT * FROM orders) LIMIT 0")).toBe(true);
    // The compiler never sees counts: a reduction that kept every row is labelled "none".
    database.onRun = (sql) => (sql.startsWith("SELECT count(*)") ? { columns: [{ name: "n", type: "BIGINT" }], rows: [[3]], rowCount: 1, truncated: false, elapsedMs: 1 } : undefined);
    const whole = await showCard(ctx, { kind: "chart", sql: "SELECT * FROM small", chart: { type: "scatter", x: "a", y: "b" } });
    expect(whole.reduction).toEqual({ method: "none", inputRows: 3, outputRows: 3 });
  });

  it("updates existing SQL while inheriting chart settings, or switches kind explicitly", async () => {
    const { ctx, sheet } = context();
    const chart = { type: "bar" as const, x: "region" };
    await showCard(ctx, { kind: "chart", sql: "SELECT region FROM orders", chart, title: "Regions" });
    const updated = await runDataTool(ctx, "data_show", { id: "c_1", sql: "SELECT region FROM orders WHERE paid" });
    expect(updated.isError).toBeUndefined();
    expect(sheet.card("c_1")).toMatchObject({ kind: "chart", title: "Regions", sql: "SELECT region FROM orders WHERE paid", chart, status: "ready" });
    expect(sheet.cards()).toHaveLength(1);
    await runDataTool(ctx, "data_show", { id: "c_1", kind: "table", sql: "SELECT 1" });
    expect(sheet.card("c_1")).toMatchObject({ kind: "table", sql: "SELECT 1", status: "ready" });
    expect(sheet.card("c_1")?.chart).toBeUndefined();
    expect(sheet.card("c_1")?.vegaLite).toBeUndefined();
    await runDataTool(ctx, "data_show", { id: "c_1", kind: "chart", sql: "SELECT region FROM orders", chart });
    expect(sheet.card("c_1")).toMatchObject({ kind: "chart", chart });
  });

  it("inherits raw Vega-Lite and preserves the ready chart when a bot edit fails", async () => {
    const { ctx, database, sheet } = context();
    await showCard(ctx, { kind: "chart", sql: "SELECT 1", vegaLite: { mark: "line" } });
    await runDataTool(ctx, "data_show", { id: "c_1", sql: "SELECT 2" });
    const good = sheet.card("c_1");
    expect(good).toMatchObject({ kind: "chart", sql: "SELECT 2", vegaLite: { mark: "line" }, status: "ready" });
    database.failNext = new Error("Parser Error: invalid edited SQL");
    expect((await runDataTool(ctx, "data_show", { id: "c_1", sql: "SELECT broken" })).isError).toBe(true);
    expect(sheet.card("c_1")).toBe(good);
    expect((await runDataTool(ctx, "data_show", { id: "c_1", sql: "SELECT 3", chart: { type: "bar", x: "region" }, vegaLite: { mark: "line" } })).isError).toBe(true);
    expect(sheet.card("c_1")).toBe(good);
  });

  it("refuses a chart over the mark cap with the aggregate hint, and leaves the card failed", async () => {
    const { ctx, database, sheet } = context();
    database.next = { rowCount: DATA_LIMITS.chartMaxMarks + 1 };
    const error = await failure(showCard(ctx, { kind: "chart", sql: "SELECT * FROM big", chart: { type: "scatter", x: "a", y: "b" } }));
    expect(error).toMatchObject({ code: "output_too_large" });
    expect(error.hint).toContain("Aggregate or filter in SQL");
    expect(sheet.card("c_1")).toMatchObject({ status: "failed", error: { code: "output_too_large" } });
  });

  it("validates a raw Vega-Lite spec and binds bounded rows", async () => {
    const { ctx, database, sheet } = context();
    const out = await showCard(ctx, { kind: "chart", sql: "SELECT a, b FROM t", vegaLite: { mark: "line" }, limit: 100 });
    expect(out.reduction).toEqual({ method: "none", inputRows: 1234, outputRows: 3 });
    expect(sheet.card("c_1")!.vegaLite).toEqual({ mark: "line", validated: true });
    expect(database.calls.find((call) => call.method === "materialise")!.sql).toBe("SELECT * FROM (SELECT a, b FROM t) LIMIT 101");
    expect(await failure(showCard(ctx, { kind: "chart", sql: "SELECT 1", vegaLite: { nope: true } }))).toMatchObject({ code: "spec_invalid" });
  });

  it("refuses contradictory inputs before touching the database", async () => {
    const { ctx, database } = context();
    expect(await failure(showCard(ctx, { sql: "SELECT 1" }))).toMatchObject({ code: "invalid_input" });
    expect(await failure(showCard(ctx, { kind: "table", sql: "SELECT 1", table: "t" }))).toMatchObject({ code: "invalid_input" });
    expect(await failure(showCard(ctx, { kind: "chart", sql: "SELECT 1" }))).toMatchObject({ code: "invalid_input" });
    expect(await failure(showCard(ctx, { kind: "chart", sql: "SELECT 1", chart: { type: "bar", x: "a" }, vegaLite: { mark: "bar" } }))).toMatchObject({ code: "invalid_input" });
    expect(await failure(showCard(ctx, { kind: "table", sql: "DROP TABLE t" }))).toMatchObject({ code: "write_refused" });
    expect(await failure(showCard(ctx, { kind: "table", sql: "CREATE TABLE x AS SELECT 1" }))).toMatchObject({ code: "write_refused" });
    expect(database.calls).toEqual([]);
  });
});

describe("data_export", () => {
  it("writes csv with COPY TO under the first allowed folder and numbers a repeat", async () => {
    const { ctx, database, dir } = context();
    await showCard(ctx, { kind: "table", sql: "SELECT * FROM orders", title: "Paid orders" });
    const out = await exportData(ctx, { id: "c_1", format: "csv" });
    expect(out.path).toBe(join(dir, "work", "paid_orders.csv"));
    expect(out).toMatchObject({ bytes: readFileSync(out.path).length, rowCount: 2 });
    expect(database.calls.at(-1)!.sql).toBe(`COPY (SELECT * FROM omb_results."c_1") TO '${out.path}' (FORMAT csv, HEADER true)`);
    const again = await exportData(ctx, { id: "c_1", format: "csv" });
    expect(again.path).toBe(join(dir, "work", "paid_orders-2.csv"));
    const parquet = await exportData(ctx, { sql: "SELECT 1 AS one", format: "parquet", path: "out/one" });
    expect(parquet.path).toBe(join(dir, "work", "out", "one.parquet"));
    expect(database.calls.at(-1)!.sql).toBe(`COPY (SELECT * FROM (SELECT 1 AS one)) TO '${parquet.path}' (FORMAT parquet)`);
    const xlsx = await exportData(ctx, { sql: "SELECT 1", format: "xlsx", path: join(dir, "Downloads") });
    expect(xlsx.path).toBe(join(dir, "Downloads", "query.xlsx"));
    expect(database.calls.at(-1)!.sql).toContain("(FORMAT xlsx, HEADER true)");
  });

  it("confines paths to the allowed folders, following symlinks", async () => {
    const { ctx, dir } = context();
    const outside = join(dir, "elsewhere");
    mkdirSync(outside);
    expect(await failure(exportData(ctx, { sql: "SELECT 1", format: "csv", path: join(outside, "x.csv") }))).toMatchObject({ code: "invalid_input", hint: expect.stringContaining(join(dir, "work")) });
    expect(await failure(exportData(ctx, { sql: "SELECT 1", format: "csv", path: "../elsewhere/x.csv" }))).toMatchObject({ code: "invalid_input" });
    symlinkSync(outside, join(dir, "work", "link"));
    expect(await failure(exportData(ctx, { sql: "SELECT 1", format: "csv", path: "link/x.csv" }))).toMatchObject({ code: "invalid_input" });
    expect(existsSync(join(outside, "x.csv"))).toBe(false);
    expect(() => resolveExportPath([], undefined, "q", "csv")).toThrow(DataFailure);
    expect(() => resolveExportPath(["relative/root"], undefined, "q", "csv")).toThrow(DataFailure);
  });

  it("renders png and svg for a chart card only", async () => {
    const { ctx, dir, rendered } = context();
    await showCard(ctx, { kind: "table", sql: "SELECT 1", title: "T" });
    await showCard(ctx, { kind: "chart", sql: "SELECT a FROM t", chart: { type: "pie", x: "a" }, title: "Share" });
    expect(await failure(exportData(ctx, { id: "c_1", format: "png" }))).toMatchObject({ code: "invalid_input" });
    expect(await failure(exportData(ctx, { table: "t", format: "svg" }))).toMatchObject({ code: "invalid_input" });
    const png = await exportData(ctx, { id: "c_2", format: "png" });
    expect(png.path).toBe(join(dir, "work", "share.png"));
    expect(readFileSync(png.path, "utf8")).toBe("png:3");
    const svg = await exportData(ctx, { id: "c_2", format: "svg", path: "~/../../../../etc/x.svg" }).catch((error: DataFailure) => error.error);
    expect(svg).toMatchObject({ code: "invalid_input" });
    expect(rendered).toEqual(["png"]);
    expect(await failure(exportData(ctx, { id: "c_7", format: "csv" }))).toMatchObject({ code: "card_not_found" });
    expect(await failure(exportData(ctx, { format: "csv" }))).toMatchObject({ code: "invalid_input" });
  });
});

describe("runDataTool", () => {
  it("answers bad arguments and unknown tools as invalid_input results, and good calls with structured content", async () => {
    const { ctx } = context();
    const unknown = await runDataTool(ctx, "data_nope", {});
    expect(unknown).toMatchObject({ isError: true, structuredContent: { code: "invalid_input" } });
    const bad = await runDataTool(ctx, "data_sql", { sql: 5 });
    expect((bad.structuredContent as { message: string }).message).toContain("sql");
    const good = await runDataTool(ctx, "data_describe", { target: "SELECT 1 AS x" });
    expect(good.isError).toBeUndefined();
    expect(good.structuredContent).toMatchObject({ sql: "SELECT 1 AS x", rowCount: 3 });
    expect(JSON.parse(good.content[0]!.text)).toEqual(good.structuredContent);
    const described = await runDataTool(ctx, "data_describe", { target: "DROP TABLE t" });
    expect(described.structuredContent).toMatchObject({ code: "write_refused" });
  });
});
