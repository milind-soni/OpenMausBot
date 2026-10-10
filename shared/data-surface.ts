// The Data surface: what the server, the bots' tools and the panel agree on.
// DuckDB runs in the OMB server (one database per bot); bots load, query and
// show data through five tools; the Computer panel's Data tab renders the
// sheet of cards. Plan: _plans/data-surface-2026-10-09/PLAN.md.

/** The five tools a bot gets, in the order the catalog lists them. */
export const DATA_TOOL_NAMES = ["data_load", "data_describe", "data_sql", "data_show", "data_export"] as const;
export type DataToolName = (typeof DATA_TOOL_NAMES)[number];

/** Bounds. Every result is capped by rows AND bytes; the gate's own trimming
 * is the backstop, never the plan. */
export const DATA_LIMITS = {
  /** `data_sql` rows returned to the model by default, and at most. */
  sqlRowsDefault: 50,
  sqlRowsMax: 500,
  /** Bytes of rows `data_sql` returns to the model. */
  sqlBytesMax: 32 * 1024,
  /** `data_describe` result bytes; beyond `describeColumnsMax` columns, types only. */
  describeBytesMax: 16 * 1024,
  describeColumnsMax: 50,
  /** Sample values per column, each at most `sampleChars` characters. */
  sampleValues: 3,
  sampleChars: 40,
  /** Rows per page the panel's grid asks for (Tad's proven size). */
  pageSize: 1024,
  /** Marks a chart may render after its SQL reduction. */
  chartMaxMarks: 10_000,
  /** Rows `data_show kind:"table"` keeps for the panel; the grid pages them. */
  showTableRowsMax: 1_000_000,
  /** One statement's wall clock before `interrupt()`. */
  sqlTimeoutMs: 60_000,
  /** Cards a sheet holds; the oldest unpinned card goes first. */
  sheetCardsMax: 200,
} as const;

/** Where materialised results live inside a bot's database. DuckDB temp
 * tables are per connection, so the panel could never see the bot's; a real
 * schema is visible to both connections and survives a restart. The Sources
 * strip hides it. */
export const DATA_RESULTS_SCHEMA = "omb_results";

export type DataErrorCode =
  | "invalid_input"
  | "source_not_found"
  | "source_unsupported"
  | "sql_error"
  | "write_refused"
  | "table_not_found"
  | "spec_invalid"
  | "card_not_found"
  | "output_too_large"
  | "timeout"
  | "cancelled"
  | "engine_unavailable";

/** The structured failure every tool and route returns. `line` is DuckDB's
 * own 1-based line in `sql`; `message` is DuckDB's text, never reworded. */
export interface DataError {
  code: DataErrorCode;
  message: string;
  sql?: string;
  line?: number;
  hint?: string;
  retryable?: boolean;
  /** For `table_not_found`: close names the bot can use instead. */
  candidates?: string[];
}

export interface DataColumn {
  name: string;
  /** DuckDB's type name as `DESCRIBE` prints it (BIGINT, VARCHAR, DECIMAL(10,2), …). */
  type: string;
  nullPct?: number;
  approxUnique?: number;
  min?: string | null;
  max?: string | null;
  /** Up to DATA_LIMITS.sampleValues distinct values, as text. */
  sample?: string[];
}

/** One entry of the bot's table catalog, as GET /data reports it from DuckDB. */
export interface DataTable {
  name: string;
  /** A quoted identifier ready to paste into SQL; `name` remains the identity. */
  sqlName?: string;
  rowCount: number;
  columns: DataColumn[];
}

/** A table the bot loaded, as the Sources strip and `data_load` report it. */
export interface DataSource {
  name: string;
  /** A quoted identifier ready to paste into SQL; name remains the source identity. */
  sqlName?: string;
  kind: "csv" | "parquet" | "json" | "xlsx" | "folder" | "url" | "postgres" | "mysql" | "sqlite" | "gsheet" | "connector" | "sql";
  /** The path, URL or connection the table came from, with credentials removed. */
  source: string;
  options?: Record<string, string | number | boolean>;
  rowCount: number;
  columns: DataColumn[];
  loadedAt: string;
}

/** What a bot says when it wants a chart. Small on purpose: the server
 * compiles it to SQL (with the reduction) and to Vega-Lite, so the model
 * never writes a chart grammar. */
export interface OmbChartSpec {
  type: "bar" | "line" | "area" | "scatter" | "histogram" | "pie" | "heatmap";
  /** Column for the x axis (the category, the time, or the value to bin). */
  x: string;
  /** Column for the y axis. Absent means count. */
  y?: string;
  /** Column to colour by (series, stack segments, heatmap cells). */
  color?: string;
  /** How y is aggregated per x (and colour). Default: sum when y is set, else count. */
  agg?: "count" | "sum" | "avg" | "min" | "max" | "median";
  /** Order of categories. Default: by x. */
  sort?: "x" | "-x" | "y" | "-y";
  /** Categories to keep (the rest fold into "other"). Default 20 for categorical x. */
  limit?: number;
  stack?: boolean;
  /** Bucket a date or timestamp x. Default: chosen from the x range. */
  timeUnit?: "hour" | "day" | "week" | "month" | "quarter" | "year";
  /** Histogram bins. Default 30. */
  bins?: number;
  /** Column for mark size (scatter). */
  size?: string;
}

/** How the compiler shrank the data before charting, shown on the card. */
export interface DataReduction {
  method: "group" | "bins" | "topN" | "timeBucket" | "m4" | "sample" | "none";
  inputRows: number;
  outputRows: number;
  note?: string;
}

export type DataCardKind = "table" | "chart" | "text";

/** One card on the sheet. The SQL is always kept so Refresh re-runs it; the
 * result table is `${DATA_RESULTS_SCHEMA}.${result}` while it exists. */
export interface DataCard {
  id: string;
  kind: DataCardKind;
  title: string;
  /** The SQL whose result this card shows (table and chart cards). */
  sql?: string;
  /** The materialised result table in DATA_RESULTS_SCHEMA, or null while running or failed. */
  result?: string | null;
  columns?: DataColumn[];
  rowCount?: number;
  truncated?: boolean;
  /** Chart cards: the bot's spec, the compiled Vega-Lite (data-free; the
   * panel binds the reduced rows as the dataset named "table"), the reduction. */
  chart?: OmbChartSpec;
  vegaLite?: Record<string, unknown>;
  reduction?: DataReduction;
  /** Text cards: Markdown. */
  text?: string;
  status: "running" | "ready" | "failed";
  error?: DataError;
  /** Who made or last changed it: the bot (tool) or the person (panel). */
  by: "bot" | "person";
  pinned?: boolean;
  createdAt: string;
  updatedAt: string;
  elapsedMs?: number;
}

/** The sheet: what the Data tab shows and what `sheet.json` stores. */
export interface DataSheet {
  version: 1;
  botId: string;
  cards: DataCard[];
  sources: DataSource[];
  updatedAt: string;
}

/** Server → client. One message carries the whole sheet; sheets are small
 * (no rows), so no patches. The database's catalog (every table, including
 * ones derived with SQL) is not on the sheet: DuckDB owns it, and GET
 * /api/bots/:id/data reads it fresh as `tables`. */
export interface DataBroadcast {
  kind: "data";
  botId: string;
  sheet: DataSheet;
}

/** Panel routes, all under `/api/bots/:botId/data`. The person's own
 * actions take the same paths as the bot's tools inside the server. */
export interface DataPageRequest {
  /** A source table name, or a card id (its result table). Exactly one. */
  table?: string;
  cardId?: string;
  offset: number;
  limit: number;
  sort?: { column: string; direction: "asc" | "desc" };
  /** Case-insensitive literal text matching, across all columns unless filterColumn is set. */
  filter?: string;
  /** Exact column name to search; values are cast to text. */
  filterColumn?: string;
}

export interface DataPage {
  columns: DataColumn[];
  /** Cells as JSON: DuckDB bigints and decimals arrive as strings. */
  rows: Array<Array<string | number | boolean | null>>;
  rowCount: number;
  offset: number;
}

export interface DataRunRequest {
  sql: string;
  /** Update this card instead of adding one. */
  cardId?: string;
  title?: string;
  /** Chart the result instead of tabling it. */
  chart?: OmbChartSpec;
  vegaLite?: Record<string, unknown>;
  /** Replace an existing result only after a successful, current live edit. */
  live?: boolean;
}

export interface DataColumnStats {
  table: string;
  rowCount: number;
  columns: DataColumn[];
}

export interface DataHistogram {
  table: string;
  column: string;
  /** Numeric and date columns: equal-width bins; text: top values. */
  bins: Array<{ label: string; count: number }>;
}

export type DataExportFormat = "csv" | "parquet" | "xlsx" | "png" | "svg";

export interface DataExportRequest {
  cardId?: string;
  table?: string;
  format: DataExportFormat;
}

export const DATA_ROUTES = {
  sheet: (botId: string) => `/api/bots/${encodeURIComponent(botId)}/data`,
  page: (botId: string) => `/api/bots/${encodeURIComponent(botId)}/data/page`,
  run: (botId: string) => `/api/bots/${encodeURIComponent(botId)}/data/run`,
  cancel: (botId: string) => `/api/bots/${encodeURIComponent(botId)}/data/cancel`,
  card: (botId: string, cardId: string) => `/api/bots/${encodeURIComponent(botId)}/data/cards/${encodeURIComponent(cardId)}`,
  stats: (botId: string, table: string) => `/api/bots/${encodeURIComponent(botId)}/data/tables/${encodeURIComponent(table)}/stats`,
  histogram: (botId: string, table: string, column: string) =>
    `/api/bots/${encodeURIComponent(botId)}/data/tables/${encodeURIComponent(table)}/histogram?column=${encodeURIComponent(column)}`,
  export: (botId: string) => `/api/bots/${encodeURIComponent(botId)}/data/export`,
  /** Server-rendered chart image for phones, Slack and email. */
  image: (botId: string, cardId: string) => `/api/bots/${encodeURIComponent(botId)}/data/cards/${encodeURIComponent(cardId)}/image`,
} as const;

/** The tab's id in the Computer panel and the storage key suffix. */
export const DATA_PANEL_VIEW = "data" as const;
