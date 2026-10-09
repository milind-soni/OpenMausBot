// The Data surface's engine: DuckDB inside the OMB server, one database per
// bot, the same on desktop, headless server and Cloud (D1, D2 in
// _plans/data-surface-2026-10-09/PLAN.md).
//
// The binding is loaded on first use through a dynamic require so esbuild
// never bundles it: the packaged app ships no node_modules, so the binding
// travels as a resource tree (resources/duckdb, staged by
// scripts/prepare-duckdb.mjs) and the Docker image sets OMB_DUCKDB_DIR. A
// binding that cannot load never throws at import; `unavailable()` says why.
//
// Each bot gets two connections, "bot" and "panel", so the person's paging
// never waits behind the bot's query and each side cancels only its own.
// `interrupt()` is per connection, so each connection runs one statement at
// a time: a cancellation always hits the statement it was meant for.
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import type * as DuckDB from "@duckdb/node-api";

import { DATA_LIMITS, DATA_RESULTS_SCHEMA } from "../../shared/data-surface.ts";
import { botFolder as defaultBotFolder } from "../bot-folder.ts";
import { DATA_DIR } from "../config.ts";
import {
  DataFailure,
  type BotDatabase,
  type DataColumn,
  type DataColumnStats,
  type DataConnection,
  type DataEngine,
  type DataHistogram,
  type DataPage,
  type DescribeResult,
  type MaterialiseResult,
  type RunOptions,
  type RunResult,
} from "./types.ts";

type Binding = typeof DuckDB;
type Cell = string | number | boolean | null;

export const DATA_DB_FILE = "data.duckdb";
export const DATA_TMP_DIR = "data-tmp";
const IDLE_CLOSE_MS = 10 * 60_000;
const HISTOGRAM_BINS = 20;
const SAMPLE_SCAN_ROWS = 1_000;
const STATS_CACHE_MAX = 64;
const PAGE_LIMIT_MAX = 10 * DATA_LIMITS.pageSize;
const RESULT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PLAIN_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export interface DataEngineOptions {
  /** Where a bot's database lives. Default: the bot folder (DATA_DIR/bots/<id>). */
  botFolder?: (botId: string) => string;
  /** Holds the shared extension directory. Default: DATA_DIR. */
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Minutes of silence before a bot's database closes; default 10. */
  idleMs?: number;
}

/** The directory whose node_modules/@duckdb holds the binding: a packaged
 * resource tree or an explicit override. Null means the server's own
 * node_modules (a checkout, the npm package). */
export function duckdbDirectory(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.OMB_DUCKDB_DIR) return env.OMB_DUCKDB_DIR;
  if (env.OMB_RESOURCES_PATH) {
    const staged = join(env.OMB_RESOURCES_PATH, "duckdb");
    if (existsSync(staged)) return staged;
  }
  return null;
}

function loadBinding(directory: string | null): Binding {
  // createRequire resolves from the given file's folder upwards, so an anchor
  // inside <dir>/node_modules finds <dir>/node_modules/@duckdb first.
  const require = createRequire(directory ? join(directory, "node_modules", "openmausbot-duckdb-anchor.js") : import.meta.url);
  return require("@duckdb/node-api") as Binding;
}

/** DuckDB's defaults assume it owns the machine (80 % of RAM, every core).
 * It shares this one with bots, Electron and the engines, and a native OOM
 * takes the whole server down, so the limits are explicit and conservative. */
export function instanceSettings(folder: string, dataDir: string, duckdbVersion: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const quarterOfRam = Math.floor(totalmem() / 4);
  const memoryMiB = Math.max(256, Math.floor(Math.min(2 * 1024 ** 3, quarterOfRam) / 1024 ** 2));
  return {
    memory_limit: env.OMB_DUCKDB_MEMORY_LIMIT || `${memoryMiB}MiB`,
    temp_directory: join(folder, DATA_TMP_DIR),
    max_temp_directory_size: env.OMB_DUCKDB_MAX_TEMP_SIZE || "20GB",
    threads: String(Math.max(1, Math.min(4, cpus().length || 1))),
    // Extensions are tied to the exact DuckDB version; a bump gets a fresh folder (D16).
    extension_directory: join(dataDir, "duckdb-extensions", duckdbVersion),
    autoinstall_known_extensions: "false",
    autoload_known_extensions: "true",
    // Persistent secrets sit unencrypted on disk; OMB's broker issues temporary ones (D15).
    allow_persistent_secrets: "false",
    preserve_insertion_order: "false",
  };
}

export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function quoteLiteral(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

/** The text a person typed in the grid's filter box, as a LIKE pattern that
 * matches it literally. */
export function likePattern(filter: string): string {
  return `%${filter.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

/** Up to five names a bot could have meant: a prefix or substring match, or
 * a few edits away, nearest first. */
export function closeNames(wanted: string, names: readonly string[], max = 5): string[] {
  const target = wanted.toLowerCase();
  const budget = Math.max(2, Math.floor(target.length / 3));
  return names
    .map((name) => {
      const folded = name.toLowerCase();
      const distance = levenshtein(target, folded);
      const related = folded.startsWith(target) || target.startsWith(folded) || folded.includes(target);
      return { name, distance: related ? Math.min(distance, 1) : distance, related };
    })
    .filter((entry) => entry.related || entry.distance <= budget)
    .sort((x, y) => x.distance - y.distance || x.name.localeCompare(y.name))
    .slice(0, max)
    .map((entry) => entry.name);
}

const COMPARABLE_TYPE = /^(?!STRUCT|MAP|UNION|JSON|GEOMETRY|VARIANT)[^[\]]*$/;
const NUMERIC_TYPE = /^(?:U?TINYINT|U?SMALLINT|U?INTEGER|U?BIGINT|U?HUGEINT|FLOAT|DOUBLE|REAL|DECIMAL\(|BIGNUM)/;
const TEMPORAL_TYPE = /^(?:DATE|TIMESTAMP)/;

function parseLine(message: string): number | undefined {
  const match = /\bLINE (\d+):/.exec(message);
  return match ? Number(match[1]) : undefined;
}

function missingTableName(message: string): string | null {
  const match = /Table with name "?([^"\n]+?)"? does not exist/.exec(message);
  return match ? match[1] : null;
}

type InterruptCause = "timeout" | "cancelled";

/** DuckDB's text travels verbatim; only the code and the position are ours. */
function failureFrom(error: unknown, sql: string, interrupted: InterruptCause | null, timeoutMs: number): DataFailure {
  if (error instanceof DataFailure) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (interrupted === "timeout") {
    return new DataFailure({ code: "timeout", message, sql, retryable: true, hint: `Stopped after ${timeoutMs} ms. Narrow the query or aggregate first.` });
  }
  if (interrupted === "cancelled") return new DataFailure({ code: "cancelled", message, sql });
  const line = parseLine(message);
  if (missingTableName(message)) return new DataFailure({ code: "table_not_found", message, sql, line });
  return new DataFailure({ code: "sql_error", message, sql, line });
}

/** One connection, one statement at a time, with the interrupt aimed at it. */
class Lane {
  private queue: Promise<unknown> = Promise.resolve();
  private running: { interrupted: InterruptCause | null } | null = null;

  constructor(readonly connection: DuckDB.DuckDBConnection) {}

  run<T>(sql: string, options: { timeoutMs?: number; signal?: AbortSignal }, work: (connection: DuckDB.DuckDBConnection) => Promise<T>): Promise<T> {
    const turn = this.queue.then(() => this.execute(sql, options, work));
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  private async execute<T>(sql: string, options: { timeoutMs?: number; signal?: AbortSignal }, work: (connection: DuckDB.DuckDBConnection) => Promise<T>): Promise<T> {
    const timeoutMs = options.timeoutMs ?? DATA_LIMITS.sqlTimeoutMs;
    if (options.signal?.aborted) throw new DataFailure({ code: "cancelled", message: "Cancelled before it ran.", sql });
    const state: { interrupted: InterruptCause | null } = { interrupted: null };
    this.running = state;
    const interrupt = (cause: InterruptCause) => {
      if (state.interrupted) return;
      state.interrupted = cause;
      this.connection.interrupt();
    };
    const timer = setTimeout(() => interrupt("timeout"), timeoutMs);
    const onAbort = () => interrupt("cancelled");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await work(this.connection);
    } catch (error) {
      throw failureFrom(error, sql, state.interrupted, timeoutMs);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      this.running = null;
    }
  }

  interrupt(): void {
    if (!this.running) return;
    this.running.interrupted ??= "cancelled";
    this.connection.interrupt();
  }
}

interface Open {
  binding: Binding;
  instance: DuckDB.DuckDBInstance;
  lanes: Record<DataConnection, Lane>;
  reserved: Set<string>;
}

interface CatalogEntry {
  schema: string;
  name: string;
  type: string;
}

function toCount(cell: Cell): number {
  return typeof cell === "string" ? Number(cell) : typeof cell === "number" ? cell : 0;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)));
}

function formatEpoch(seconds: number, dateOnly: boolean): string {
  const iso = new Date(seconds * 1000).toISOString();
  return dateOnly ? iso.slice(0, 10) : iso.slice(0, 16).replace("T", " ");
}

class BotDb implements BotDatabase {
  private state: Promise<Open> | null = null;
  private closing: Promise<void> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private inFlight = 0;
  private readonly statsCache = new Map<string, DataColumnStats>();

  constructor(readonly botId: string, private readonly engine: Engine) {}

  private open(): Promise<Open> {
    if (!this.state) {
      // The file admits one instance per process: a reopen waits for the
      // close that may still be draining.
      const previous = this.closing ?? Promise.resolve();
      const opening = previous.then(() => this.openNow());
      this.state = opening;
      opening.catch(() => {
        if (this.state === opening) this.state = null;
      });
    }
    this.touch();
    return this.state;
  }

  private async openNow(): Promise<Open> {
    const binding = this.engine.binding();
    const folder = this.engine.folder(this.botId);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const settings = instanceSettings(folder, this.engine.dataDir, binding.version(), this.engine.env);
    const instance = await binding.DuckDBInstance.create(join(folder, DATA_DB_FILE), settings);
    let bot: DuckDB.DuckDBConnection | undefined;
    let panel: DuckDB.DuckDBConnection | undefined;
    try {
      bot = await instance.connect();
      panel = await instance.connect();
      // Results live in a real schema: temp tables would be invisible to the
      // panel's connection (DATA_RESULTS_SCHEMA).
      await bot.run(`CREATE SCHEMA IF NOT EXISTS ${DATA_RESULTS_SCHEMA}`);
      const keywords = await bot.runAndReadAll("SELECT keyword_name FROM duckdb_keywords() WHERE keyword_category = 'reserved'");
      const reserved = new Set(keywords.getRowsJson().map((row) => String(row[0]).toLowerCase()));
      return { binding, instance, lanes: { bot: new Lane(bot), panel: new Lane(panel) }, reserved };
    } catch (error) {
      bot?.closeSync();
      panel?.closeSync();
      instance.closeSync();
      throw error;
    }
  }

  /** Closes after a quiet stretch, never under a running statement: a long
   * load simply pushes the close out. */
  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.inFlight > 0) this.touch();
      else void this.close();
    }, this.engine.idleMs);
    this.idleTimer.unref();
  }

  private async statement<T>(connection: DataConnection, sql: string, options: { timeoutMs?: number; signal?: AbortSignal }, work: (open: Open, conn: DuckDB.DuckDBConnection) => Promise<T>): Promise<T> {
    this.inFlight++;
    try {
      const open = await this.open();
      return await open.lanes[connection].run(sql, options, (conn) => work(open, conn));
    } catch (error) {
      if (error instanceof DataFailure && error.error.code === "table_not_found" && !error.error.candidates) {
        const wanted = missingTableName(error.error.message);
        if (wanted) error.error.candidates = await this.candidates(wanted).catch(() => []);
      }
      throw error;
    } finally {
      this.inFlight--;
      this.touch();
    }
  }

  private cells(binding: Binding, chunk: DuckDB.DuckDBDataChunk): Cell[][] {
    const json = binding.JsonDuckDBValueConverter;
    return chunk.convertRows<Cell>((value, type) => {
      if (value === null) return null;
      if (type.typeId === binding.DuckDBTypeId.BLOB) return `<blob ${(value as DuckDB.DuckDBBlobValue).bytes.length} bytes>`;
      const converted = json(value, type, json);
      return converted !== null && typeof converted === "object" ? JSON.stringify(converted) : converted;
    }) as Cell[][];
  }

  private resultColumns(result: DuckDB.DuckDBResult): DataColumn[] {
    return Array.from({ length: result.columnCount }, (_, i) => ({ name: result.columnName(i), type: result.columnType(i).toString() }));
  }

  /** A statement's rows as JSON cells, bounded; the exact count comes free
   * with a materialised result. */
  private async read(open: Open, conn: DuckDB.DuckDBConnection, sql: string, maxRows = Infinity): Promise<RunResult> {
    const started = performance.now();
    const result = await conn.run(sql);
    const rows: Cell[][] = [];
    for (let i = 0; i < result.chunkCount && rows.length < maxRows; i++) {
      for (const row of this.cells(open.binding, result.getChunk(i))) {
        if (rows.length >= maxRows) break;
        rows.push(row);
      }
    }
    return { columns: this.resultColumns(result), rows, rowCount: result.rowCount, truncated: rows.length < result.rowCount, elapsedMs: Math.round(performance.now() - started) };
  }

  async run(sql: string, options: RunOptions): Promise<RunResult> {
    const maxRows = options.maxRows === undefined ? Infinity : Math.max(0, options.maxRows);
    return this.statement(options.connection, sql, options, (open, conn) => this.read(open, conn, sql, maxRows));
  }

  async materialise(sql: string, name: string, options: RunOptions): Promise<MaterialiseResult> {
    if (!RESULT_NAME.test(name)) throw new DataFailure({ code: "invalid_input", message: `Result name "${name}" must be a plain identifier (letters, digits, underscore).` });
    const table = `${DATA_RESULTS_SCHEMA}.${name}`;
    const body = sql.trim().replace(/;+\s*$/, "");
    const create = `CREATE OR REPLACE TABLE ${table} AS ${body}`;
    return this.statement(options.connection, sql, options, async (open, conn) => {
      const started = performance.now();
      const created = await this.read(open, conn, create);
      const described = await this.read(open, conn, `DESCRIBE ${table}`);
      return {
        table,
        columns: described.rows.map((row) => ({ name: String(row[0]), type: String(row[1]) })),
        rowCount: toCount(created.rows[0]?.[0] ?? 0),
        elapsedMs: Math.round(performance.now() - started),
      };
    });
  }

  async dropResult(name: string): Promise<void> {
    if (!RESULT_NAME.test(name)) throw new DataFailure({ code: "invalid_input", message: `Result name "${name}" must be a plain identifier (letters, digits, underscore).` });
    const sql = `DROP TABLE IF EXISTS ${DATA_RESULTS_SCHEMA}.${name}`;
    await this.statement("bot", sql, {}, (open, conn) => this.read(open, conn, sql));
  }

  private async catalog(connection: DataConnection = "panel"): Promise<CatalogEntry[]> {
    const sql = "SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_catalog = current_database() AND table_schema NOT IN ('information_schema', 'pg_catalog') ORDER BY table_schema, table_name";
    const result = await this.statement(connection, sql, {}, (open, conn) => this.read(open, conn, sql));
    return result.rows.map((row) => ({ schema: String(row[0]), name: String(row[1]), type: String(row[2]) }));
  }

  private displayName(entry: CatalogEntry): string {
    return entry.schema === "main" ? entry.name : `${entry.schema}.${entry.name}`;
  }

  private qualified(entry: CatalogEntry, reserved: Set<string>): string {
    const part = (name: string) => (PLAIN_IDENTIFIER.test(name) && !reserved.has(name) ? name : quoteIdentifier(name));
    return `${part(entry.schema)}.${part(entry.name)}`;
  }

  /** `a.b`, `"A B".c`, or a bare name, with quotes removed. */
  private splitIdentifier(text: string): string[] {
    const parts: string[] = [];
    let current = "";
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (char === '"') {
        if (quoted && text[i + 1] === '"') { current += '"'; i++; }
        else quoted = !quoted;
      } else if (char === "." && !quoted) {
        parts.push(current);
        current = "";
      } else current += char;
    }
    parts.push(current);
    return parts.map((part) => part.trim());
  }

  private async lookup(name: string): Promise<CatalogEntry> {
    const parts = this.splitIdentifier(name.trim()).slice(-2);
    const table = parts[parts.length - 1];
    const schema = parts.length === 2 ? parts[0] : null;
    if (!table) throw new DataFailure({ code: "invalid_input", message: "A table name is required." });
    const entries = await this.catalog();
    const inSchema = schema ? entries.filter((entry) => entry.schema === schema || entry.schema.toLowerCase() === schema.toLowerCase()) : entries;
    // Bare names mean the bot's own tables first, then results, then anything attached.
    const rank = (entry: CatalogEntry) => (entry.schema === "main" ? 0 : entry.schema === DATA_RESULTS_SCHEMA ? 1 : 2);
    const exact = inSchema.filter((entry) => entry.name === table).sort((x, y) => rank(x) - rank(y));
    const folded = inSchema.filter((entry) => entry.name.toLowerCase() === table.toLowerCase()).sort((x, y) => rank(x) - rank(y));
    const found = exact[0] ?? folded[0];
    if (found) return found;
    throw new DataFailure({
      code: "table_not_found",
      message: `Table ${name.trim()} does not exist.`,
      candidates: closeNames(table, entries.map((entry) => this.displayName(entry))),
    });
  }

  private async candidates(wanted: string): Promise<string[]> {
    const entries = await this.catalog();
    const table = this.splitIdentifier(wanted).pop() ?? wanted;
    return closeNames(table, entries.map((entry) => this.displayName(entry)));
  }

  async resolveTable(name: string): Promise<string> {
    const entry = await this.lookup(name);
    const open = await this.open();
    return this.qualified(entry, open.reserved);
  }

  private async columnsOf(connection: DataConnection, from: string, options: { timeoutMs?: number; signal?: AbortSignal }): Promise<DataColumn[]> {
    const sql = `DESCRIBE ${from}`;
    const result = await this.statement(connection, sql, options, (open, conn) => this.read(open, conn, sql));
    return result.rows.map((row) => ({ name: String(row[0]), type: String(row[1]) }));
  }

  /** The explorer's numbers in as few scans as the types allow: null and
   * distinct counts for every column in one pass, min/max for the comparable
   * ones in another. SUMMARIZE would be one statement but 10-25x slower (D10). */
  private async aggregate(connection: DataConnection, from: string, columns: DataColumn[], options: { timeoutMs?: number; signal?: AbortSignal }): Promise<{ rowCount: number; columns: DataColumn[] }> {
    const countSql = `SELECT count(*) FROM ${from}`;
    const count = await this.statement(connection, countSql, options, (open, conn) => this.read(open, conn, countSql));
    const rowCount = toCount(count.rows[0]?.[0] ?? 0);
    const enriched: DataColumn[] = columns.map((column) => ({ ...column }));
    if (!columns.length) return { rowCount, columns: enriched };

    const nullsSql = `SELECT ${columns.map((column) => `count(${quoteIdentifier(column.name)}), approx_count_distinct(${quoteIdentifier(column.name)})`).join(", ")} FROM ${from}`;
    const nulls = await this.statement(connection, nullsSql, options, (open, conn) => this.read(open, conn, nullsSql));
    const nullRow = nulls.rows[0] ?? [];
    enriched.forEach((column, i) => {
      const nonNull = toCount(nullRow[i * 2] ?? 0);
      column.nullPct = rowCount ? Math.round(((rowCount - nonNull) / rowCount) * 1000) / 10 : 0;
      column.approxUnique = toCount(nullRow[i * 2 + 1] ?? 0);
    });

    const comparable = enriched.filter((column) => COMPARABLE_TYPE.test(column.type));
    if (comparable.length) {
      const rangeSql = `SELECT ${comparable.map((column) => `CAST(min(${quoteIdentifier(column.name)}) AS VARCHAR), CAST(max(${quoteIdentifier(column.name)}) AS VARCHAR)`).join(", ")} FROM ${from}`;
      const range = await this.statement(connection, rangeSql, options, (open, conn) => this.read(open, conn, rangeSql));
      const rangeRow = range.rows[0] ?? [];
      comparable.forEach((column, i) => {
        column.min = rangeRow[i * 2] === undefined ? null : (rangeRow[i * 2] as string | null);
        column.max = rangeRow[i * 2 + 1] === undefined ? null : (rangeRow[i * 2 + 1] as string | null);
      });
    }
    return { rowCount, columns: enriched };
  }

  /** `target` is a table (bare or qualified) or a query. */
  private async source(target: string): Promise<string> {
    const text = target.trim().replace(/;+\s*$/, "");
    const looksLikeName = /^[\w."$ -]+$/.test(text) && !/\s(?:from|select|with|values)\s/i.test(text) && !/^(?:select|with|from|values|pivot|unpivot|show|describe)\b/i.test(text);
    if (looksLikeName) return this.resolveTable(text);
    return `(${text}) AS omb_described`;
  }

  async describe(target: string, options: RunOptions): Promise<DescribeResult> {
    const from = await this.source(target);
    const all = await this.columnsOf(options.connection, from, options);
    const profiled = all.slice(0, DATA_LIMITS.describeColumnsMax);
    const { rowCount, columns } = await this.aggregate(options.connection, from, profiled, options);
    if (profiled.length) {
      // Three distinct values per column from one bounded scan: enough for
      // text-to-SQL, cheap on any table size.
      const samplesSql = `SELECT ${profiled.map((column) => `list(DISTINCT CAST(${quoteIdentifier(column.name)} AS VARCHAR)) FILTER (WHERE ${quoteIdentifier(column.name)} IS NOT NULL)[1:${DATA_LIMITS.sampleValues}]`).join(", ")} FROM (SELECT * FROM ${from} LIMIT ${SAMPLE_SCAN_ROWS})`;
      const samples = await this.statement(options.connection, samplesSql, options, (open, conn) => this.read(open, conn, samplesSql));
      const sampleRow = samples.rows[0] ?? [];
      columns.forEach((column, i) => {
        const cell = sampleRow[i];
        let values: unknown;
        try { values = typeof cell === "string" ? JSON.parse(cell) : cell; } catch { values = []; }
        column.sample = Array.isArray(values) ? values.map((value) => String(value).slice(0, DATA_LIMITS.sampleChars)) : [];
      });
    }
    return { rowCount, columns: [...columns, ...all.slice(DATA_LIMITS.describeColumnsMax)] };
  }

  async stats(table: string, options: { signal?: AbortSignal } = {}): Promise<DataColumnStats> {
    const entry = await this.lookup(table);
    const open = await this.open();
    const from = this.qualified(entry, open.reserved);
    const countSql = `SELECT count(*) FROM ${from}`;
    const count = await this.statement("panel", countSql, options, (o, conn) => this.read(o, conn, countSql));
    const rowCount = toCount(count.rows[0]?.[0] ?? 0);
    const key = `${from}\u0000${rowCount}`;
    const cached = this.statsCache.get(key);
    if (cached) return cached;
    const columns = await this.columnsOf("panel", from, options);
    const aggregated = await this.aggregate("panel", from, columns, options);
    const stats: DataColumnStats = { table: this.displayName(entry), rowCount: aggregated.rowCount, columns: aggregated.columns };
    if (this.statsCache.size >= STATS_CACHE_MAX) this.statsCache.clear();
    this.statsCache.set(key, stats);
    return stats;
  }

  async histogram(table: string, column: string, options: { bins?: number; signal?: AbortSignal } = {}): Promise<DataHistogram> {
    const entry = await this.lookup(table);
    const open = await this.open();
    const from = this.qualified(entry, open.reserved);
    const columns = await this.columnsOf("panel", from, options);
    const found = columns.find((c) => c.name === column) ?? columns.find((c) => c.name.toLowerCase() === column.toLowerCase());
    if (!found) throw new DataFailure({ code: "invalid_input", message: `Column "${column}" is not in ${this.displayName(entry)}.`, candidates: closeNames(column, columns.map((c) => c.name)) });
    const bins = Math.max(1, Math.min(200, Math.floor(options.bins ?? HISTOGRAM_BINS)));
    const id = quoteIdentifier(found.name);
    const numeric = NUMERIC_TYPE.test(found.type);
    const temporal = !numeric && TEMPORAL_TYPE.test(found.type);
    const result: DataHistogram = { table: this.displayName(entry), column: found.name, bins: [] };

    if (numeric || temporal) {
      const value = numeric ? `CAST(${id} AS DOUBLE)` : `epoch(CAST(${id} AS TIMESTAMP))`;
      const sql = `WITH omb_range AS (SELECT min(${value}) AS lo, max(${value}) AS hi FROM ${from} WHERE ${id} IS NOT NULL)
SELECT coalesce(LEAST(floor((${value} - omb_range.lo) / nullif(omb_range.hi - omb_range.lo, 0) * ${bins}), ${bins - 1}), 0)::INTEGER AS bin, count(*) AS n, min(omb_range.lo), min(omb_range.hi)
FROM ${from}, omb_range WHERE ${id} IS NOT NULL GROUP BY bin ORDER BY bin`;
      const rows = (await this.statement("panel", sql, options, (o, conn) => this.read(o, conn, sql))).rows;
      if (!rows.length) return result;
      const lo = Number(rows[0][2]);
      const hi = Number(rows[0][3]);
      const width = (hi - lo) / bins;
      const counts = new Map(rows.map((row) => [toCount(row[0]), toCount(row[1])]));
      const label = (i: number) => {
        const start = lo + i * width;
        if (temporal) return formatEpoch(start, found.type.startsWith("DATE"));
        return width ? `${formatNumber(start)} – ${formatNumber(start + width)}` : formatNumber(lo);
      };
      const shown = width ? bins : 1;
      result.bins = Array.from({ length: shown }, (_, i) => ({ label: label(i), count: counts.get(i) ?? 0 }));
      return result;
    }

    const sql = `SELECT CAST(${id} AS VARCHAR) AS v, count(*) AS n FROM ${from} WHERE ${id} IS NOT NULL GROUP BY v ORDER BY n DESC, v LIMIT ${bins}`;
    const rows = (await this.statement("panel", sql, options, (o, conn) => this.read(o, conn, sql))).rows;
    result.bins = rows.map((row) => ({ label: String(row[0]).slice(0, 2 * DATA_LIMITS.sampleChars), count: toCount(row[1]) }));
    return result;
  }

  async page(target: string, options: { offset: number; limit: number; sort?: { column: string; direction: "asc" | "desc" }; filter?: string; signal?: AbortSignal }): Promise<DataPage> {
    const entry = await this.lookup(target);
    const open = await this.open();
    const from = this.qualified(entry, open.reserved);
    const columns = await this.columnsOf("panel", from, options);
    const offset = Math.max(0, Math.floor(options.offset) || 0);
    const limit = Math.max(1, Math.min(PAGE_LIMIT_MAX, Math.floor(options.limit) || DATA_LIMITS.pageSize));

    const filter = options.filter?.trim();
    const where = filter
      ? ` WHERE ${columns.map((column) => `CAST(${quoteIdentifier(column.name)} AS VARCHAR) ILIKE ${quoteLiteral(likePattern(filter))} ESCAPE '\\'`).join(" OR ")}`
      : "";

    // With preserve_insertion_order off a scan's order is not fixed, so every
    // page orders by something: rowid keeps a table's pages stable and
    // breaks ties under a sort. Views have no rowid.
    const tiebreak = entry.type === "VIEW" ? [] : ["rowid"];
    const order: string[] = [];
    if (options.sort) {
      const sortColumn = columns.find((c) => c.name === options.sort!.column) ?? columns.find((c) => c.name.toLowerCase() === options.sort!.column.toLowerCase());
      if (!sortColumn) throw new DataFailure({ code: "invalid_input", message: `Cannot sort by "${options.sort.column}": not a column of ${this.displayName(entry)}.`, candidates: closeNames(options.sort.column, columns.map((c) => c.name)) });
      order.push(`${quoteIdentifier(sortColumn.name)} ${options.sort.direction === "desc" ? "DESC" : "ASC"} NULLS LAST`);
    }
    order.push(...tiebreak);
    const orderBy = order.length ? ` ORDER BY ${order.join(", ")}` : "";

    const countSql = `SELECT count(*) FROM ${from}${where}`;
    const pageSql = `SELECT * FROM ${from}${where}${orderBy} LIMIT ${limit} OFFSET ${offset}`;
    const sql = `${countSql};\n${pageSql}`;
    return this.statement("panel", sql, options, async (o, conn) => {
      const count = await this.read(o, conn, countSql);
      const rows = await this.read(o, conn, pageSql);
      return { columns, rows: rows.rows, rowCount: toCount(count.rows[0]?.[0] ?? 0), offset };
    });
  }

  async listTables(): Promise<Array<{ name: string; rowCount: number; columns: DataColumn[] }>> {
    const entries = (await this.catalog()).filter((entry) => entry.schema !== DATA_RESULTS_SCHEMA);
    if (!entries.length) return [];
    const open = await this.open();
    const columnsSql = "SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns WHERE table_catalog = current_database() ORDER BY table_schema, table_name, ordinal_position";
    const columnRows = await this.statement("panel", columnsSql, {}, (o, conn) => this.read(o, conn, columnsSql));
    const columnsByTable = new Map<string, DataColumn[]>();
    for (const row of columnRows.rows) {
      const key = `${row[0]}\u0000${row[1]}`;
      const list = columnsByTable.get(key) ?? [];
      list.push({ name: String(row[2]), type: String(row[3]) });
      columnsByTable.set(key, list);
    }
    // One statement for every count: a table's count(*) is metadata, a view's is a scan.
    const countSql = `SELECT ${entries.map((entry) => `(SELECT count(*) FROM ${this.qualified(entry, open.reserved)})`).join(", ")}`;
    const counts = await this.statement("panel", countSql, {}, (o, conn) => this.read(o, conn, countSql));
    const countRow = counts.rows[0] ?? [];
    return entries.map((entry, i) => ({
      name: this.displayName(entry),
      rowCount: toCount(countRow[i] ?? 0),
      columns: columnsByTable.get(`${entry.schema}\u0000${entry.name}`) ?? [],
    }));
  }

  interrupt(connection: DataConnection): void {
    if (!this.state) return;
    void this.state.then((open) => open.lanes[connection].interrupt(), () => undefined);
  }

  async close(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const pending = this.state;
    if (!pending) return this.closing ?? undefined;
    this.state = null;
    this.statsCache.clear();
    const closing = (async () => {
      let open: Open;
      try { open = await pending; } catch { return; }
      // Closing a connection with a statement in flight is undefined; interrupt
      // first, then let the lanes drain.
      for (const lane of Object.values(open.lanes)) lane.interrupt();
      await Promise.all(Object.values(open.lanes).map((lane) => lane.run("", {}, async () => undefined).catch(() => undefined)));
      for (const lane of Object.values(open.lanes)) lane.connection.closeSync();
      open.instance.closeSync();
    })();
    this.closing = closing;
    try { await closing; } finally { if (this.closing === closing) this.closing = null; }
  }

  get isOpen(): boolean {
    return this.state !== null;
  }
}

class Engine implements DataEngine {
  private readonly databases = new Map<string, BotDb>();
  private loaded: { binding: Binding } | { reason: string } | null = null;
  readonly env: NodeJS.ProcessEnv;
  readonly dataDir: string;
  readonly idleMs: number;
  readonly folder: (botId: string) => string;

  constructor(options: DataEngineOptions) {
    this.env = options.env ?? process.env;
    this.dataDir = options.dataDir ?? DATA_DIR;
    this.idleMs = options.idleMs ?? IDLE_CLOSE_MS;
    this.folder = options.botFolder ?? defaultBotFolder;
  }

  private load(): { binding: Binding } | { reason: string } {
    if (this.loaded) return this.loaded;
    const directory = duckdbDirectory(this.env);
    try {
      this.loaded = { binding: loadBinding(directory) };
    } catch (error) {
      const detail = (error instanceof Error ? error.message : String(error)).split("\n")[0].trim();
      const where = directory ? `from ${directory}` : "from the server's node_modules";
      const action = directory
        ? "Reinstall OpenMausBot, or point OMB_DUCKDB_DIR at a folder holding node_modules/@duckdb."
        : "Run pnpm install, or set OMB_DUCKDB_DIR to a folder holding node_modules/@duckdb.";
      this.loaded = { reason: `DuckDB did not load ${where}: ${detail}. ${action}` };
    }
    return this.loaded;
  }

  binding(): Binding {
    const loaded = this.load();
    if ("binding" in loaded) return loaded.binding;
    throw new DataFailure({ code: "engine_unavailable", message: loaded.reason });
  }

  unavailable(): string | null {
    const loaded = this.load();
    return "reason" in loaded ? loaded.reason : null;
  }

  async forBot(botId: string): Promise<BotDatabase> {
    if (!botId || /[\\/]|^\.\.?$/.test(botId)) throw new DataFailure({ code: "invalid_input", message: `Not a bot id: "${botId}".` });
    this.binding();
    let db = this.databases.get(botId);
    if (!db) {
      db = new BotDb(botId, this);
      this.databases.set(botId, db);
    }
    return db;
  }

  async deleteBot(botId: string): Promise<void> {
    const db = this.databases.get(botId);
    this.databases.delete(botId);
    await db?.close();
    const folder = this.folder(botId);
    for (const name of [DATA_DB_FILE, `${DATA_DB_FILE}.wal`, DATA_TMP_DIR]) {
      rmSync(join(folder, name), { recursive: true, force: true });
    }
  }

  async closeAll(): Promise<void> {
    const open = [...this.databases.values()];
    this.databases.clear();
    await Promise.all(open.map((db) => db.close()));
  }
}

export function createDataEngine(options: DataEngineOptions = {}): DataEngine {
  return new Engine(options);
}

/** The server's engine. Nothing loads until a bot's database is first asked for. */
export const dataEngine: DataEngine = createDataEngine();
