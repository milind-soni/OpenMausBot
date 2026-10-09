// Server-side seams of the Data surface. Three modules meet here so each can
// be built and tested on its own: the engine (DuckDB), the tools and routes
// (what bots and the panel call), and the chart compiler (spec → SQL + Vega-Lite).
import type {
  DataColumn,
  DataColumnStats,
  DataError,
  DataHistogram,
  DataPage,
  DataReduction,
  DataSource,
  OmbChartSpec,
} from "../../shared/data-surface.ts";

export type { DataColumn, DataColumnStats, DataError, DataHistogram, DataPage, DataReduction, DataSource, OmbChartSpec };

/** A DuckDB failure as the tools report it. Thrown by the engine; carries the
 * structured error so callers never parse messages. */
export class DataFailure extends Error {
  readonly error: DataError;
  constructor(error: DataError) {
    super(error.message);
    this.name = "DataFailure";
    this.error = error;
  }
}

/** Which of a bot's two connections runs a statement. The bot's tools and the
 * person's panel actions never block each other, and each can be cancelled
 * without touching the other. */
export type DataConnection = "bot" | "panel";
export type DataExtension = "httpfs" | "excel" | "azure" | "postgres" | "mysql" | "sqlite";

export interface RunOptions {
  connection: DataConnection;
  /** Default DATA_LIMITS.sqlTimeoutMs. */
  timeoutMs?: number;
  /** Aborting interrupts the statement on its connection. */
  signal?: AbortSignal;
  /** Rows to return. Default: all (callers bound their own SQL). */
  maxRows?: number;
  /** Supported extensions this operation needs, installed and loaded before it runs. */
  extensions?: DataExtension[];
}

export interface RunResult {
  columns: DataColumn[];
  /** JSON cells: bigints and decimals as strings, dates and timestamps as text. */
  rows: Array<Array<string | number | boolean | null>>;
  /** Exact row count of the statement's result when known. */
  rowCount: number;
  truncated: boolean;
  elapsedMs: number;
}

export interface MaterialiseResult {
  /** Fully qualified: `omb_results.<name>`. */
  table: string;
  columns: DataColumn[];
  rowCount: number;
  elapsedMs: number;
}

export interface DescribeResult {
  rowCount: number;
  columns: DataColumn[];
}

/** One bot's database. Obtained from `DataEngine.forBot`; shared by the
 * tools, the routes and the sheet. */
export interface BotDatabase {
  readonly botId: string;
  /** Runs one statement and returns its rows (bounded by `maxRows`). */
  run(sql: string, options: RunOptions): Promise<RunResult>;
  /** `CREATE OR REPLACE TABLE omb_results.<name> AS <sql>`, with its count. */
  materialise(sql: string, name: string, options: RunOptions): Promise<MaterialiseResult>;
  /** Drops a result table; a missing one is not an error. Runs on
   * `connection` (default the bot's), so a panel edit never waits behind
   * whatever the bot is running. */
  dropResult(name: string, connection?: DataConnection): Promise<void>;
  /** Pages a source table or a result table with the panel's connection. */
  page(target: string, options: { offset: number; limit: number; sort?: { column: string; direction: "asc" | "desc" }; filter?: string; filterColumn?: string; signal?: AbortSignal }): Promise<DataPage>;
  /** Column types, null %, approx distinct, min/max and up to 3 samples. */
  describe(target: string, options: RunOptions): Promise<DescribeResult>;
  /** The explorer's single-pass stats, cached until the database changes. */
  stats(table: string, options?: { signal?: AbortSignal }): Promise<DataColumnStats>;
  histogram(table: string, column: string, options?: { bins?: number; signal?: AbortSignal }): Promise<DataHistogram>;
  /** Tables and views outside DATA_RESULTS_SCHEMA, with counts. */
  listTables(): Promise<Array<{ name: string; sqlName?: string; rowCount: number; columns: DataColumn[] }>>;
  /** Cancels whatever runs on that connection right now. */
  interrupt(connection: DataConnection): void;
  /** Resolves a bare or qualified identifier; `table_not_found` with candidates otherwise. */
  resolveTable(name: string): Promise<string>;
  /** Flushes and closes; the next `forBot` reopens. */
  close(): Promise<void>;
}

export interface DataEngine {
  /** Why DuckDB cannot run here, or null when it can (the binding loaded). */
  unavailable(): string | null;
  forBot(botId: string): Promise<BotDatabase>;
  /** Closes the bot's database and deletes its files. */
  deleteBot(botId: string): Promise<void>;
  closeAll(): Promise<void>;
}

/** The chart compiler: a bot's small spec plus the result's columns → the
 * reducing SQL (over `from`, a table or a subquery), the data-free Vega-Lite
 * spec, and the reduction it chose. Throws DataFailure(spec_invalid) for a
 * spec that names missing columns or mixes incompatible encodings. */
export interface CompiledChart {
  /** Selects the reduced rows; the panel binds them as dataset "table". */
  sql: string;
  vegaLite: Record<string, unknown>;
  reduction: Omit<DataReduction, "inputRows" | "outputRows">;
}

export type ChartCompiler = (spec: OmbChartSpec, columns: DataColumn[], from: string) => CompiledChart;

/** Validates a raw Vega-Lite spec (the escape hatch): the JSON schema, no
 * inline data, then one headless render. Returns the normalised spec or
 * throws DataFailure(spec_invalid) with the validator's message. */
export type VegaLiteValidator = (spec: unknown) => Promise<Record<string, unknown>>;

/** Renders a card's chart with its rows to SVG, or PNG at a width/scale/theme. */
export interface ChartRenderer {
  svg(vegaLite: Record<string, unknown>, rows: RunResult["rows"], columns: DataColumn[], options: { theme: "light" | "dark"; width?: number }): Promise<string>;
  png(vegaLite: Record<string, unknown>, rows: RunResult["rows"], columns: DataColumn[], options: { theme: "light" | "dark"; width?: number; scale?: number }): Promise<Buffer>;
}
