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

export class DataFailure extends Error {
  readonly error: DataError;
  constructor(error: DataError) {
    super(error.message);
    this.name = "DataFailure";
    this.error = error;
  }
}

export type DataConnection = "bot" | "panel";
export type DataExtension = "httpfs" | "excel" | "azure" | "postgres" | "mysql" | "sqlite";

export interface RunOptions {
  connection: DataConnection;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxRows?: number;
  extensions?: DataExtension[];
}

export interface RunResult {
  columns: DataColumn[];
  /** JSON cells: bigints and decimals as strings, dates and timestamps as text. */
  rows: Array<Array<string | number | boolean | null>>;
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

export interface BotDatabase {
  readonly botId: string;
  run(sql: string, options: RunOptions): Promise<RunResult>;
  materialise(sql: string, name: string, options: RunOptions): Promise<MaterialiseResult>;
  /** A missing table is not an error. */
  dropResult(name: string, connection?: DataConnection): Promise<void>;
  page(target: string, options: { offset: number; limit: number; sort?: { column: string; direction: "asc" | "desc" }; filter?: string; filterColumn?: string; signal?: AbortSignal }): Promise<DataPage>;
  describe(target: string, options: RunOptions): Promise<DescribeResult>;
  stats(table: string, options?: { signal?: AbortSignal }): Promise<DataColumnStats>;
  histogram(table: string, column: string, options?: { bins?: number; signal?: AbortSignal }): Promise<DataHistogram>;
  listTables(): Promise<Array<{ name: string; sqlName?: string; rowCount: number; columns: DataColumn[] }>>;
  interrupt(connection: DataConnection): void;
  /** Resolves a bare or qualified identifier; `table_not_found` with candidates otherwise. */
  resolveTable(name: string): Promise<string>;
  close(): Promise<void>;
}

export interface DataEngine {
  unavailable(): string | null;
  forBot(botId: string): Promise<BotDatabase>;
  deleteBot(botId: string): Promise<void>;
  closeAll(): Promise<void>;
}

/** Compiling throws DataFailure(spec_invalid) for a spec that names missing columns or mixes incompatible encodings. */
export interface CompiledChart {
  /** Selects the reduced rows; the panel binds them as dataset "table". */
  sql: string;
  vegaLite: Record<string, unknown>;
  reduction: Omit<DataReduction, "inputRows" | "outputRows">;
}

export type ChartCompiler = (spec: OmbChartSpec, columns: DataColumn[], from: string) => CompiledChart;

/** The JSON schema, no inline data, then one headless render; throws DataFailure(spec_invalid) with the validator's message. */
export type VegaLiteValidator = (spec: unknown) => Promise<Record<string, unknown>>;

export interface ChartRenderer {
  svg(vegaLite: Record<string, unknown>, rows: RunResult["rows"], columns: DataColumn[], options: { theme: "light" | "dark"; width?: number }): Promise<string>;
  png(vegaLite: Record<string, unknown>, rows: RunResult["rows"], columns: DataColumn[], options: { theme: "light" | "dark"; width?: number; scale?: number }): Promise<Buffer>;
}
