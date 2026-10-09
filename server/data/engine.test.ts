// The DuckDB engine against the real binding, loaded the way the packaged
// app loads it: from a tree outside node_modules named by OMB_DUCKDB_DIR.
// Every database lives in a throwaway folder; nothing touches DATA_DIR.
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { DATA_LIMITS, DATA_RESULTS_SCHEMA } from "../../shared/data-surface.ts";
import { CLOSE_DRAIN_MS, closeNames, createDataEngine, dataEngine, drainLanes, duckdbDirectory, instanceSettings, levenshtein, likePattern, type DataEngineOptions } from "./engine.ts";
import { DataFailure, type BotDatabase, type DataEngine } from "./types.ts";

const root = mkdtempSync(join(tmpdir(), "omb-data-engine-"));
const outOfTree = join(root, "duckdb-resources");
const nodeApi = realpathSync(join(process.cwd(), "node_modules", "@duckdb", "node-api"));
const bindings = realpathSync(join(nodeApi, "..", "node-bindings"));
const platform = realpathSync(join(bindings, "..", `node-bindings-${process.platform}-${process.arch}`));
for (const [name, source] of [["node-api", nodeApi], ["node-bindings", bindings], [`node-bindings-${process.platform}-${process.arch}`, platform]]) {
  cpSync(source, join(outOfTree, "node_modules", "@duckdb", name), { recursive: true, dereference: true });
}

const LONG_QUERY = "SELECT count(*) FROM range(100000000) x, range(100000000) y";
const engines: DataEngine[] = [];

function engine(overrides: Partial<DataEngineOptions> = {}): DataEngine {
  const created = createDataEngine({
    botFolder: (botId) => join(root, "bots", botId),
    dataDir: join(root, "data"),
    env: { ...process.env, OMB_DUCKDB_DIR: outOfTree, OMB_RESOURCES_PATH: undefined },
    ...overrides,
  });
  engines.push(created);
  return created;
}

async function failure(promise: Promise<unknown>): Promise<DataFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DataFailure) return error;
    throw error;
  }
  throw new Error("expected a DataFailure");
}

const bot = { connection: "bot" as const };
const panel = { connection: "panel" as const };

afterAll(async () => {
  // On Windows CI, DuckDB's native close blocks the worker thread after
  // these tests (the hook timed out with no JavaScript timer firing), so no
  // bound in here can help. The process exit reclaims the handles; the
  // tests themselves have already decided the result.
  if (process.platform === "win32") {
    console.warn("engine.test: leaving the databases to the process on Windows (native close blocks the thread)");
    return;
  }
  // A close gives up on a stuck statement after CLOSE_DRAIN_MS; the hook must
  // outlast that for every engine.
  const closing = Promise.all(engines.map((e) => e.closeAll()));
  const gaveUp = new Promise<"gave-up">((resolve) => setTimeout(() => resolve("gave-up"), CLOSE_DRAIN_MS * 2).unref());
  if (await Promise.race([closing.then(() => "closed" as const), gaveUp]) === "gave-up") throw new Error("closeAll did not finish");
  // Windows keeps a just-closed database busy for a while (EPERM on rm); a
  // temp directory left on a runner is not a test failure there. rm's retry
  // delay grows linearly, so 10 × 100 ms stays well inside the hook timeout.
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}, CLOSE_DRAIN_MS * 4);

describe("closing", () => {
  it("drains idle lanes at once, and gives up on one that never finishes", async () => {
    const idle = { run: async <T,>(_sql: string, _options: object, work: () => Promise<T>) => work() };
    expect(await drainLanes([idle, idle], 1_000)).toBe(true);
    const stuck = { run: <T,>() => new Promise<T>(() => undefined) };
    const started = Date.now();
    expect(await drainLanes([idle, stuck], 50)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("loading the binding", () => {
  it("prefers OMB_DUCKDB_DIR, then a staged resources tree, then node_modules", () => {
    const staged = join(root, "resources");
    mkdirSync(join(staged, "duckdb"), { recursive: true });
    expect(duckdbDirectory({ OMB_DUCKDB_DIR: "/x", OMB_RESOURCES_PATH: staged })).toBe("/x");
    expect(duckdbDirectory({ OMB_RESOURCES_PATH: staged })).toBe(join(staged, "duckdb"));
    expect(duckdbDirectory({ OMB_RESOURCES_PATH: join(root, "nowhere") })).toBeNull();
    expect(duckdbDirectory({})).toBeNull();
  });

  it("loads from the copied out-of-tree directory", async () => {
    const e = engine();
    expect(e.unavailable()).toBeNull();
    const db = await e.forBot("loader");
    const result = await db.run("SELECT 1 AS one", bot);
    expect(result.rows).toEqual([[1]]);
    const loaded = Object.keys(createRequire(import.meta.url).cache).filter((file) => file.startsWith(realpathSync(outOfTree)));
    expect(loaded.some((file) => file.endsWith("duckdb.node"))).toBe(true);
  });

  it("names the directory and an action when the binding is missing, in one line, without throwing", async () => {
    const missing = join(root, "no-binding-here");
    const e = engine({ env: { ...process.env, OMB_DUCKDB_DIR: missing } });
    const reason = e.unavailable();
    expect(reason).toContain(missing);
    expect(reason).toMatch(/OMB_DUCKDB_DIR/);
    expect(reason).not.toContain("\n");
    const error = await failure(e.forBot("x"));
    expect(error.error.code).toBe("engine_unavailable");
    expect(error.error.message).toBe(reason);
  });

  it("ships a default engine that loads nothing until asked", () => {
    expect(typeof dataEngine.forBot).toBe("function");
    expect(dataEngine.unavailable()).toBeNull();
  });

  it("refuses a bot id that is not a folder name", async () => {
    const e = engine();
    expect((await failure(e.forBot("../escape"))).error.code).toBe("invalid_input");
    expect((await failure(e.forBot(""))).error.code).toBe("invalid_input");
  });
});

describe("instance settings", () => {
  it("caps memory at a quarter of RAM or 2 GB, threads at four, and keeps extensions per version", () => {
    const settings = instanceSettings("/bots/b", "/data", "v1.5.6", {});
    const expectedMiB = Math.max(256, Math.floor(Math.min(2 * 1024 ** 3, Math.floor(totalmem() / 4)) / 1024 ** 2));
    expect(settings.memory_limit).toBe(`${expectedMiB}MiB`);
    expect(settings.threads).toBe(String(Math.min(4, cpus().length)));
    expect(settings.temp_directory).toBe(join("/bots/b", "data-tmp"));
    expect(settings.extension_directory).toBe(join("/data", "duckdb-extensions", "v1.5.6"));
    expect(settings.max_temp_directory_size).toBe("20GB");
    expect(settings.allow_persistent_secrets).toBe("false");
    expect(settings.autoinstall_known_extensions).toBe("false");
    expect(settings.autoload_known_extensions).toBe("true");
    expect(settings.preserve_insertion_order).toBe("false");
    expect(instanceSettings("/b", "/d", "v1", { OMB_DUCKDB_MEMORY_LIMIT: "3GB", OMB_DUCKDB_MAX_TEMP_SIZE: "1GB" })).toMatchObject({ memory_limit: "3GB", max_temp_directory_size: "1GB" });
  });

  it("applies them to the opened database", async () => {
    const e = engine({ env: { ...process.env, OMB_DUCKDB_DIR: outOfTree, OMB_DUCKDB_MEMORY_LIMIT: "300MiB" } });
    const db = await e.forBot("settings");
    const names = ["memory_limit", "threads", "temp_directory", "extension_directory", "allow_persistent_secrets", "preserve_insertion_order", "autoinstall_known_extensions", "autoload_known_extensions"];
    const result = await db.run(`SELECT ${names.map((name) => `current_setting('${name}')`).join(", ")}`, bot);
    const [memory, threads, temp, extensions, secrets, order, autoinstall, autoload] = result.rows[0];
    expect(memory).toBe("300.0 MiB");
    expect(threads).toBe(String(Math.min(4, cpus().length)));
    expect(temp).toBe(join(root, "bots", "settings", "data-tmp"));
    expect(String(extensions).startsWith(join(root, "data", "duckdb-extensions"))).toBe(true);
    expect(String(extensions)).toMatch(/v\d+\.\d+\.\d+$/);
    expect([secrets, order, autoinstall, autoload]).toEqual([false, false, false, true]);
    expect(existsSync(join(root, "bots", "settings", "data.duckdb"))).toBe(true);
  });
});

describe("a bot's database", () => {
  const e = engine();
  let db: BotDatabase;
  const ready = (async () => {
    db = await e.forBot("alpha");
    await db.run("CREATE OR REPLACE TABLE sales AS SELECT range AS id, 'n' || range AS name, (range % 7)::DECIMAL(10,2) AS amt, DATE '2024-01-01' + INTERVAL (range) DAY AS day, CASE WHEN range % 4 = 0 THEN NULL ELSE 'v' || (range % 5) END AS v FROM range(100)", bot);
  })();

  it("runs a statement, bounds the rows and keeps the exact count", async () => {
    await ready;
    const all = await db.run("SELECT id FROM sales ORDER BY id", bot);
    expect(all.rowCount).toBe(100);
    expect(all.rows.length).toBe(100);
    expect(all.truncated).toBe(false);
    expect(all.columns).toEqual([{ name: "id", type: "BIGINT" }]);
    expect(typeof all.elapsedMs).toBe("number");
    const some = await db.run("SELECT id FROM sales ORDER BY id", { ...bot, maxRows: 3 });
    expect(some.rows).toEqual([["0"], ["1"], ["2"]]);
    expect(some.rowCount).toBe(100);
    expect(some.truncated).toBe(true);
  });

  it("returns JSON cells: big numbers and decimals as text, dates as DuckDB prints them, blobs by size, nested values as JSON text", async () => {
    await ready;
    const result = await db.run(`SELECT 1::BIGINT AS big, 1.25::DECIMAL(10,2) AS dec, DATE '2024-01-02' AS d, TIMESTAMP '2024-01-02 03:04:05' AS ts, 'ab'::BLOB AS bl, [1,2] AS l, {'x':1} AS st, INTERVAL 1 DAY AS iv, 1::HUGEINT AS hu, 1.5::DOUBLE AS dbl, true AS bo, NULL::INTEGER AS nul, MAP {'k':1} AS mp, 'x' AS v`, bot);
    expect(result.columns.map((c) => c.type)).toEqual(["BIGINT", "DECIMAL(10,2)", "DATE", "TIMESTAMP", "BLOB", "INTEGER[]", 'STRUCT("x" INTEGER)', "INTERVAL", "HUGEINT", "DOUBLE", "BOOLEAN", "INTEGER", "MAP(VARCHAR, INTEGER)", "VARCHAR"]);
    expect(result.rows[0]).toEqual(["1", "1.25", "2024-01-02", "2024-01-02 03:04:05", "<blob 2 bytes>", "[1,2]", '{"x":1}', '{"months":0,"days":1,"micros":"0"}', "1", 1.5, true, null, '[{"key":"k","value":1}]', "x"]);
  });

  it("materialises a result in the results schema, where the panel's connection sees it", async () => {
    await ready;
    const made = await db.materialise("SELECT id, amt FROM sales WHERE id < 10;", "q1", bot);
    expect(made).toMatchObject({ table: `${DATA_RESULTS_SCHEMA}.q1`, rowCount: 10, columns: [{ name: "id", type: "BIGINT" }, { name: "amt", type: "DECIMAL(10,2)" }] });
    const seen = await db.run(`SELECT count(*) FROM ${DATA_RESULTS_SCHEMA}.q1`, panel);
    expect(seen.rows).toEqual([["10"]]);
    // The reason the schema exists: a temp table is the bot connection's alone.
    await db.run("CREATE TEMP TABLE scratch AS SELECT 1 AS x", bot);
    expect((await failure(db.run("SELECT * FROM scratch", panel))).error.code).toBe("table_not_found");
    expect((await failure(db.materialise("SELECT 1", "bad name", bot))).error.code).toBe("invalid_input");
  });

  it("drops a result, and a missing one is not an error", async () => {
    await ready;
    await db.materialise("SELECT 1 AS one", "gone", bot);
    await db.dropResult("gone");
    await db.dropResult("gone");
    expect((await failure(db.run(`SELECT * FROM ${DATA_RESULTS_SCHEMA}.gone`, bot))).error.code).toBe("table_not_found");
  });

  it("pages with a stable order, sorts, and filters by text across every column", async () => {
    await ready;
    const asc = await db.page("sales", { offset: 10, limit: 5, sort: { column: "id", direction: "asc" } });
    expect(asc.rows.map((row) => row[0])).toEqual(["10", "11", "12", "13", "14"]);
    expect(asc).toMatchObject({ rowCount: 100, offset: 10 });
    expect(asc.columns.map((c) => c.name)).toEqual(["id", "name", "amt", "day", "v"]);
    const desc = await db.page("sales", { offset: 0, limit: 2, sort: { column: "ID", direction: "desc" } });
    expect(desc.rows.map((row) => row[0])).toEqual(["99", "98"]);

    const seen = new Set<string>();
    for (let offset = 0; offset < 100; offset += 30) {
      for (const row of (await db.page("sales", { offset, limit: 30 })).rows) seen.add(String(row[0]));
    }
    expect(seen.size).toBe(100);

    const filtered = await db.page("sales", { offset: 0, limit: 50, filter: "N1" });
    expect(filtered.rowCount).toBe(11);
    expect(filtered.rows.every((row) => String(row[1]).toLowerCase().includes("n1"))).toBe(true);
    const literal = await db.page("sales", { offset: 0, limit: 50, filter: "n%" });
    expect(literal.rowCount).toBe(0);
    const injected = await db.page("sales", { offset: 0, limit: 50, filter: "'; DROP TABLE sales; --" });
    expect(injected.rowCount).toBe(0);
    expect((await db.run("SELECT count(*) FROM sales", bot)).rows).toEqual([["100"]]);

    const bad = await failure(db.page("sales", { offset: 0, limit: 5, sort: { column: "nope", direction: "asc" } }));
    expect(bad.error.code).toBe("invalid_input");
  });

  it("describes a table or a query: types, null %, approx distinct, min/max as text, three samples", async () => {
    await ready;
    const described = await db.describe("sales", bot);
    expect(described.rowCount).toBe(100);
    const v = described.columns.find((c) => c.name === "v")!;
    expect(v).toMatchObject({ type: "VARCHAR", nullPct: 25, approxUnique: 5, min: "v0", max: "v4" });
    expect(v.sample!.length).toBe(DATA_LIMITS.sampleValues);
    expect(v.sample!.every((s) => /^v[0-4]$/.test(s))).toBe(true);
    const id = described.columns.find((c) => c.name === "id")!;
    expect(id).toMatchObject({ nullPct: 0, min: "0", max: "99" });
    expect(id.approxUnique).toBeGreaterThan(90);
    const day = described.columns.find((c) => c.name === "day")!;
    expect(day.min).toBe("2024-01-01 00:00:00");

    const query = await db.describe("SELECT id FROM sales WHERE id < 10", bot);
    expect(query.rowCount).toBe(10);
    expect(query.columns[0]).toMatchObject({ name: "id", max: "9" });
  });

  it("profiles at most describeColumnsMax columns and lists the rest by type only", async () => {
    await ready;
    const wide = Array.from({ length: DATA_LIMITS.describeColumnsMax + 5 }, (_, i) => `${i} AS c${i}`).join(", ");
    const described = await db.describe(`SELECT ${wide}`, bot);
    expect(described.columns.length).toBe(DATA_LIMITS.describeColumnsMax + 5);
    expect(described.columns[0].nullPct).toBe(0);
    expect(described.columns[DATA_LIMITS.describeColumnsMax - 1].sample).toEqual([String(DATA_LIMITS.describeColumnsMax - 1)]);
    expect(described.columns[DATA_LIMITS.describeColumnsMax]).toEqual({ name: `c${DATA_LIMITS.describeColumnsMax}`, type: "INTEGER" });
  });

  it("caches column stats by table and row count", async () => {
    await ready;
    await db.run("CREATE OR REPLACE TABLE counted AS SELECT range AS n FROM range(10)", bot);
    const first = await db.stats("counted");
    expect(first).toMatchObject({ table: "counted", rowCount: 10 });
    expect(first.columns[0]).toMatchObject({ name: "n", nullPct: 0, min: "0", max: "9" });
    expect(await db.stats("counted")).toBe(first);
    await db.run("INSERT INTO counted VALUES (10)", bot);
    const second = await db.stats("counted");
    expect(second).not.toBe(first);
    expect(second.rowCount).toBe(11);
    expect(second.columns[0].max).toBe("10");
  });

  it("bins numbers and dates into twenty equal widths and counts the top text values", async () => {
    await ready;
    const ids = await db.histogram("sales", "id");
    expect(ids.bins.length).toBe(20);
    expect(ids.bins.every((bin) => bin.count === 5)).toBe(true);
    expect(ids.bins[0].label).toBe("0 – 4.95");
    const days = await db.histogram("sales", "day");
    expect(days.bins.length).toBe(20);
    expect(days.bins[0].label).toBe("2024-01-01 00:00");
    expect(days.bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(100);
    const dates = await db.histogram("sales", "day", { bins: 4 });
    expect(dates.bins.map((bin) => bin.count)).toEqual([25, 25, 25, 25]);
    const text = await db.histogram("sales", "v");
    expect(text.bins.length).toBe(5);
    expect(text.bins[0].count).toBeGreaterThanOrEqual(text.bins[1].count);
    expect(text.bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(75);
    const constant = await db.histogram("SELECT 1", "x").catch((error) => error);
    expect(constant).toBeInstanceOf(DataFailure);
    expect((await failure(db.histogram("sales", "nope"))).error.code).toBe("invalid_input");
  });

  it("lists tables and views with counts and columns, never the results schema", async () => {
    await ready;
    await db.run("CREATE OR REPLACE VIEW big_sales AS SELECT * FROM sales WHERE amt > 3", bot);
    await db.materialise("SELECT 1", "hidden", bot);
    const tables = await db.listTables();
    const names = tables.map((table) => table.name);
    expect(names).toContain("sales");
    expect(names).toContain("big_sales");
    expect(names.some((name) => name.includes(DATA_RESULTS_SCHEMA))).toBe(false);
    const sales = tables.find((table) => table.name === "sales")!;
    expect(sales.rowCount).toBe(100);
    expect(sales.columns.map((c) => c.name)).toEqual(["id", "name", "amt", "day", "v"]);
    expect(sales.columns[2].type).toBe("DECIMAL(10,2)");
    const viewCount = Number((await db.run("SELECT count(*) FROM big_sales", bot)).rows[0][0]);
    expect(tables.find((table) => table.name === "big_sales")!.rowCount).toBe(viewCount);
  });

  it("resolves names case-insensitively, bare or qualified, quoting only what needs it", async () => {
    await ready;
    await db.run('CREATE OR REPLACE TABLE "order" (x INT)', bot);
    await db.run('CREATE OR REPLACE TABLE "My Table" (x INT)', bot);
    expect(await db.resolveTable("SALES")).toBe("main.sales");
    expect(await db.resolveTable("main.sales")).toBe("main.sales");
    expect(await db.resolveTable('"Main"."Sales"')).toBe("main.sales");
    expect(await db.resolveTable("q1")).toBe(`${DATA_RESULTS_SCHEMA}.q1`);
    expect(await db.resolveTable(`${DATA_RESULTS_SCHEMA}.Q1`)).toBe(`${DATA_RESULTS_SCHEMA}.q1`);
    expect(await db.resolveTable("order")).toBe('main."order"');
    expect(await db.resolveTable("my table")).toBe('main."My Table"');
    const missing = await failure(db.resolveTable("salez"));
    expect(missing.error.code).toBe("table_not_found");
    expect(missing.error.candidates).toContain("sales");
    expect(missing.error.candidates!.length).toBeLessThanOrEqual(5);
  });

  it("maps DuckDB errors to codes without rewording them", async () => {
    await ready;
    const parse = await failure(db.run("SELEC 1", bot));
    expect(parse.error).toMatchObject({ code: "sql_error", sql: "SELEC 1", line: 1 });
    expect(parse.error.message).toContain('syntax error at or near "SELEC"');
    const missing = await failure(db.run("SELECT *\nFROM salez", bot));
    expect(missing.error).toMatchObject({ code: "table_not_found", line: 2 });
    expect(missing.error.message).toContain("Table with name salez does not exist");
    expect(missing.error.candidates).toContain("sales");
    const binder = await failure(db.run("SELECT nope FROM sales", bot));
    expect(binder.error.code).toBe("sql_error");
    expect(binder.error.message).toMatch(/^Binder Error/);
  });
});

describe("cancellation", () => {
  it("maps a timeout to `timeout` (retryable) and leaves the connection usable", async () => {
    const db = await engine().forBot("slow");
    const started = Date.now();
    const error = await failure(db.run(LONG_QUERY, { ...bot, timeoutMs: 150 }));
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(error.error).toMatchObject({ code: "timeout", retryable: true, sql: LONG_QUERY });
    expect(error.error.message).toMatch(/interrupt/i);
    expect(error.error.hint).toContain("150 ms");
    expect((await db.run("SELECT 42", bot)).rows).toEqual([[42]]);
  });

  it("maps an aborted signal to `cancelled`", async () => {
    const db = await engine().forBot("aborted");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const error = await failure(db.run(LONG_QUERY, { ...bot, signal: controller.signal }));
    expect(error.error.code).toBe("cancelled");
    // A slow runner may not have started the statement within 100 ms; then
    // the signal is seen before it runs, which is cancelled all the same.
    expect(error.error.message).toMatch(/interrupt|cancelled before it ran/i);
    const early = new AbortController();
    early.abort();
    expect((await failure(db.run("SELECT 1", { ...bot, signal: early.signal }))).error.code).toBe("cancelled");
  });

  it("interrupts one connection while the other keeps working, and queued statements still run", async () => {
    const db = await engine().forBot("two-lanes");
    const long = db.run(LONG_QUERY, panel);
    const queued = db.run("SELECT 7", panel);
    const other = await db.run("SELECT 'bot side'", bot);
    expect(other.rows).toEqual([["bot side"]]);
    db.interrupt("panel");
    expect((await failure(long)).error.code).toBe("cancelled");
    expect((await queued).rows).toEqual([[7]]);
    db.interrupt("bot");
    expect((await db.run("SELECT 8", bot)).rows).toEqual([[8]]);
  });
});

describe("lifecycle", () => {
  it("closes an idle database and reopens it on the next use with its data intact", async () => {
    const e = engine({ idleMs: 250 });
    const db = await e.forBot("idle");
    await db.run("CREATE TABLE kept AS SELECT 1 AS x", bot);
    const inner = db as unknown as { isOpen: boolean };
    expect(inner.isOpen).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(inner.isOpen).toBe(false);
    expect((await db.run("SELECT count(*) FROM kept", panel)).rows).toEqual([["1"]]);
    expect(inner.isOpen).toBe(true);
    await db.close();
    expect(inner.isOpen).toBe(false);
    expect((await db.run("SELECT x FROM kept", bot)).rows).toEqual([[1]]);
  });

  it("does not close under a statement that outlives the idle window", async () => {
    const e = engine({ idleMs: 200 });
    const db = await e.forBot("busy");
    const controller = new AbortController();
    const long = db.run(LONG_QUERY, { ...bot, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect((db as unknown as { isOpen: boolean }).isOpen).toBe(true);
    controller.abort();
    expect((await failure(long)).error.code).toBe("cancelled");
  });

  it("deletes a bot's database, its WAL and its spill directory", async () => {
    const e = engine();
    const db = await e.forBot("doomed");
    await db.run("CREATE TABLE t AS SELECT 1", bot);
    const folder = join(root, "bots", "doomed");
    // Leftovers of an earlier run: written once the database is closed, since
    // Windows refuses to open the WAL while DuckDB holds it.
    await db.close();
    mkdirSync(join(folder, "data-tmp"), { recursive: true });
    writeFileSync(join(folder, "data-tmp", "spill.tmp"), "x");
    writeFileSync(join(folder, "data.duckdb.wal"), "x");
    writeFileSync(join(folder, "SOUL.md"), "keep me");
    await e.deleteBot("doomed");
    expect(existsSync(join(folder, "data.duckdb"))).toBe(false);
    expect(existsSync(join(folder, "data.duckdb.wal"))).toBe(false);
    expect(existsSync(join(folder, "data-tmp"))).toBe(false);
    expect(existsSync(join(folder, "SOUL.md"))).toBe(true);
    const again = await e.forBot("doomed");
    expect((await failure(again.run("SELECT * FROM t", bot))).error.code).toBe("table_not_found");
  });

  it("closeAll closes every open database", async () => {
    const e = engine();
    const a = await e.forBot("ca");
    const b = await e.forBot("cb");
    await Promise.all([a.run("SELECT 1", bot), b.run("SELECT 1", bot)]);
    await e.closeAll();
    expect((a as unknown as { isOpen: boolean }).isOpen).toBe(false);
    expect((b as unknown as { isOpen: boolean }).isOpen).toBe(false);
  });
});

describe("helpers", () => {
  it("escapes LIKE wildcards in a person's filter text", () => {
    expect(likePattern("a%b_c\\d")).toBe("%a\\%b\\_c\\\\d%");
  });

  it("measures edit distance and offers the nearest names first", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("", "abc")).toBe(3);
    expect(closeNames("salez", ["sales", "orders", "sale_items", "zzz"])).toEqual(["sales"]);
    expect(closeNames("sale", ["sales", "orders", "sale_items", "zzz"])).toEqual(["sales", "sale_items"]);
    expect(closeNames("ord", ["orders", "sales", "words"])).toEqual(["orders", "words"]);
    expect(closeNames("x", Array.from({ length: 10 }, (_, i) => `x${i}`)).length).toBe(5);
  });
});
