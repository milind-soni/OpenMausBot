// The five Data tools as every engine sees them (data_load, data_describe,
// data_sql, data_show, data_export), served at POST /api/internal/data/mcp
// through harness-mcp-proxy, and the same operations the panel's routes run
// for the person (showCard, runSql, exportData with connection "panel").
// Everything DuckDB is reached through the injected BotDatabase; every SQL
// string built here quotes its literals and identifiers, and every result is
// bounded by rows and bytes before it leaves (the gate's trimming is only the
// backstop). Failures are structured DataErrors the model can act on.
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import type { ValidateFunction } from "ajv";

import {
  DATA_LIMITS,
  DATA_RESULTS_SCHEMA,
  type DataCard,
  type DataColumn,
  type DataError,
  type DataErrorCode,
  type DataExportFormat,
  type DataReduction,
  type DataSource,
  type OmbChartSpec,
} from "../../shared/data-surface.ts";
import { compileToolSchema, schemaProblems } from "../mcp-schema-validator.ts";
import type { DataSheetStore } from "./sheet.ts";
import { DataFailure, type BotDatabase, type ChartCompiler, type ChartRenderer, type DataConnection, type RunOptions, type RunResult, type VegaLiteValidator } from "./types.ts";

// ── the catalog ──

const IDENT = "^[A-Za-z_][A-Za-z0-9_]{0,62}$";
const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) =>
  ({ name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } });

const CHART_SPEC_SCHEMA = {
  type: "object",
  description: "A small chart spec the server compiles to SQL (with the reduction) and Vega-Lite.",
  properties: {
    type: { type: "string", enum: ["bar", "line", "area", "scatter", "histogram", "pie", "heatmap"] },
    x: { type: "string", maxLength: 200, description: "Column for the x axis: the category, the time, or the value to bin." },
    y: { type: "string", maxLength: 200, description: "Column for the y axis. Absent means count." },
    color: { type: "string", maxLength: 200, description: "Column to colour by (series, stack segments, heatmap cells)." },
    agg: { type: "string", enum: ["count", "sum", "avg", "min", "max", "median"], description: "How y is aggregated per x. Default: sum when y is set, else count." },
    sort: { type: "string", enum: ["x", "-x", "y", "-y"] },
    limit: { type: "integer", minimum: 1, maximum: 1000, description: "Categories to keep; the rest fold into \"other\". Default 20." },
    stack: { type: "boolean" },
    timeUnit: { type: "string", enum: ["hour", "day", "week", "month", "quarter", "year"] },
    bins: { type: "integer", minimum: 2, maximum: 500, description: "Histogram bins. Default 30." },
    size: { type: "string", maxLength: 200, description: "Column for mark size (scatter)." },
  },
  required: ["type", "x"],
  additionalProperties: false,
};

export const DATA_TOOLS = [
  tool(
    "data_load",
    "Load data into a named table of this bot's database: a local file, folder or glob (csv, tsv, json, ndjson, parquet, xlsx, sqlite; .gz/.zst too), an http(s)/s3/gs/az URL, a postgres:// or mysql:// connection string (snapshots the tables read-only), or a Google Sheets URL. Replaces a table of the same name unless replace is false. Returns each table's columns, row count and sample values.",
    {
      source: { type: "string", minLength: 1, maxLength: 4000 },
      name: { type: "string", pattern: IDENT, description: "Table name. Default: from the file name." },
      kind: { type: "string", enum: ["auto", "csv", "tsv", "parquet", "json", "xlsx", "sqlite", "folder", "url", "postgres", "mysql", "gsheet"], description: "Default auto: decided from the source." },
      sheet: { type: "string", maxLength: 200, description: "The workbook sheet, or the table (schema.table) to snapshot from a database. Default: the first sheet; every table." },
      replace: { type: "boolean", description: "Default true." },
      options: {
        type: "object",
        properties: {
          header: { type: "boolean" },
          delimiter: { type: "string", minLength: 1, maxLength: 4 },
          union_by_name: { type: "boolean" },
          all_varchar: { type: "boolean" },
          ignore_errors: { type: "boolean", description: "Skip rows that do not parse instead of failing." },
          sample_size: { type: "integer", minimum: -1, maximum: 10000000 },
        },
        additionalProperties: false,
      },
    },
    ["source"],
  ),
  tool(
    "data_describe",
    "Columns of a table or of a SELECT's result: type, null %, approximate distinct count, min, max and up to three sample values. Call it before writing SQL against a table you have not seen.",
    { target: { type: "string", minLength: 1, maxLength: 20000, description: "A table name, or a SELECT statement." } },
    ["target"],
  ),
  tool(
    "data_sql",
    "Run one DuckDB statement. SELECT-like statements are kept as a result table (omb_results.q_<n>) you can show or export, and return columns, the exact row count and the first rows. CREATE [OR REPLACE] TABLE|VIEW … AS … is allowed; other writes are refused (load data with data_load instead).",
    {
      sql: { type: "string", minLength: 1, maxLength: 100000 },
      limit: { type: "integer", minimum: 1, maximum: DATA_LIMITS.sqlRowsMax, description: `Rows to return. Default ${DATA_LIMITS.sqlRowsDefault}.` },
      name: { type: "string", pattern: IDENT, description: "Name for the result table instead of q_<n>." },
    },
    ["sql"],
  ),
  tool(
    "data_show",
    "Put a table or a chart on the Data tab the person sees. Give sql (a SELECT) or table (a loaded table); kind \"chart\" also takes chart (the small spec: type, x, y, color, agg, …) or, rarely, vegaLite (a data-free Vega-Lite spec). Pass an existing id to change that card in place; otherwise a new card is added at the bottom. Aggregate or filter in SQL first: a chart may draw at most 10,000 marks.",
    {
      id: { type: "string", pattern: "^c_[0-9]+$" },
      title: { type: "string", maxLength: 200 },
      sql: { type: "string", minLength: 1, maxLength: 100000 },
      table: { type: "string", minLength: 1, maxLength: 300 },
      kind: { type: "string", enum: ["table", "chart"] },
      chart: CHART_SPEC_SCHEMA,
      vegaLite: { type: "object", description: "Escape hatch: a Vega-Lite spec without data; the rows bind as the dataset named \"table\"." },
      limit: { type: "integer", minimum: 1, maximum: DATA_LIMITS.showTableRowsMax, description: "Rows a table card keeps (default all, up to 1,000,000) or rows handed to a raw vegaLite spec (default 10,000)." },
    },
    ["kind"],
  ),
  tool(
    "data_export",
    "Write a card (id), a loaded table or a SELECT to a file: csv, parquet or xlsx for data; png or svg for a chart card. The path must be inside the bot's working folder or the person's Downloads; default: Downloads.",
    {
      id: { type: "string", pattern: "^c_[0-9]+$" },
      table: { type: "string", minLength: 1, maxLength: 300 },
      sql: { type: "string", minLength: 1, maxLength: 100000 },
      format: { type: "string", enum: ["csv", "parquet", "xlsx", "png", "svg"] },
      path: { type: "string", minLength: 1, maxLength: 4000 },
    },
    ["format"],
  ),
];

let validators: Map<string, ValidateFunction> | undefined;

/** Why a call cannot run, or null: the advertised schema is the contract. */
export function dataToolCallProblem(name: unknown, args: unknown): string | null {
  validators ??= new Map(DATA_TOOLS.map((entry) => [entry.name, compileToolSchema(entry.inputSchema, { allErrors: true })]));
  const validate = typeof name === "string" ? validators.get(name) : undefined;
  if (!validate) return "Unknown Data tool. Use one of data_load, data_describe, data_sql, data_show, data_export.";
  if (!args || typeof args !== "object" || Array.isArray(args) || !validate(args)) {
    return `Tool arguments do not match the advertised input schema: ${schemaProblems(validate.errors).join("; ") || "use its required fields and types"}.`;
  }
  return null;
}

// ── SQL building blocks ──

export const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;
export const quoteLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** A relation expression for a result table in DATA_RESULTS_SCHEMA. */
export const resultRelation = (name: string) => `${DATA_RESULTS_SCHEMA}.${quoteIdent(name)}`;

const fail = (code: DataErrorCode, message: string, extra: Partial<DataError> = {}): DataFailure =>
  new DataFailure({ code, message, ...extra });

// ── the statement gate ──

/** `text` is the uppercased word for matching; `raw` is what was written. */
type Token = { kind: "word" | "ident" | "punct" | "block"; text: string; raw: string };

/** Top-level tokens of one statement: words, quoted identifiers, `,`, and
 * every parenthesised group collapsed to one block. Strings, comments and
 * quoted identifiers never leak a keyword. Throws for an unterminated quote
 * or comment. Returns the number of statements (top-level `;` with content
 * after it) as well. */
function topLevelTokens(sql: string): { tokens: Token[]; statements: number } {
  const tokens: Token[] = [];
  let statements = 1;
  let depth = 0;
  let i = 0;
  const n = sql.length;
  const push = (kind: Token["kind"], raw: string, text = raw) => { if (depth === 0) tokens.push({ kind, text, raw }); };
  while (i < n) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === "-" && next === "-") { const end = sql.indexOf("\n", i); i = end === -1 ? n : end + 1; continue; }
    if (ch === "/" && next === "*") { const end = sql.indexOf("*/", i + 2); if (end === -1) throw fail("invalid_input", "Unterminated comment."); i = end + 2; continue; }
    if (ch === "'") {
      let j = i + 1;
      for (;;) {
        const q = sql.indexOf("'", j);
        if (q === -1) throw fail("invalid_input", "Unterminated string literal.");
        if (sql[q + 1] === "'") { j = q + 2; continue; }
        j = q + 1; break;
      }
      push("word", "'…'");
      i = j; continue;
    }
    if (ch === "$" && next === "$") {
      const end = sql.indexOf("$$", i + 2);
      if (end === -1) throw fail("invalid_input", "Unterminated dollar-quoted string.");
      push("word", "'…'");
      i = end + 2; continue;
    }
    if (ch === '"') {
      let j = i + 1;
      for (;;) {
        const q = sql.indexOf('"', j);
        if (q === -1) throw fail("invalid_input", "Unterminated quoted identifier.");
        if (sql[q + 1] === '"') { j = q + 2; continue; }
        j = q + 1; break;
      }
      push("ident", sql.slice(i, j));
      i = j; continue;
    }
    if (ch === "(") { push("block", "(…)"); depth++; i++; continue; }
    if (ch === ")") { depth = Math.max(0, depth - 1); i++; continue; }
    if (ch === ";") {
      // A trailing semicolon is fine; content after one is a second statement.
      if (depth === 0 && /\S/.test(sql.slice(i + 1).replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, "").replace(/[;\s]+$/, ""))) statements++;
      i++; continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$.]/.test(sql[j]!)) j++;
      push("word", sql.slice(i, j), sql.slice(i, j).toUpperCase());
      i = j; continue;
    }
    if (ch === ",") { push("punct", ","); i++; continue; }
    // whitespace, numbers, operators, dots, casts (::), named-argument arrows: never a verb
    i++;
  }
  return { tokens, statements };
}

const READ_VERBS = new Set(["SELECT", "WITH", "FROM", "PIVOT", "UNPIVOT", "VALUES", "SUMMARIZE", "DESCRIBE", "EXPLAIN", "SHOW"]);
/** Statements whose result `CREATE TABLE … AS` can hold; the others are
 * metadata the model reads once. */
const MATERIALISABLE = new Set(["SELECT", "WITH", "FROM", "PIVOT", "UNPIVOT", "VALUES"]);

export type SqlClass =
  | { kind: "read"; materialisable: boolean }
  | { kind: "create"; target: string }
  | { kind: "refused"; verb: string };

/** What one statement is, judged by its verb (and the verb after a CTE
 * list), so a column called `comment` or `load` is never mistaken for a
 * write and a `WITH … DELETE` never passes as a read. */
export function classifySql(sql: string): SqlClass {
  const { tokens, statements } = topLevelTokens(sql);
  if (statements > 1) throw fail("invalid_input", "One statement per call.", { hint: "Send each statement in its own data_sql call." });
  if (!tokens.length || tokens[0]!.kind !== "word") throw fail("invalid_input", "The statement is empty.");
  let i = 0;
  let verb = tokens[0]!.text;
  const withClause = verb === "WITH";
  if (withClause) {
    // WITH [RECURSIVE] name [(cols)] AS [[NOT] MATERIALIZED] (body) [, …] <verb>
    i = 1;
    if (tokens[i]?.text === "RECURSIVE") i++;
    for (;;) {
      while (i < tokens.length && tokens[i]!.kind !== "block") i++; // name, AS, MATERIALIZED, or (cols)
      i++;
      if (tokens[i]?.text === "AS") { // a (cols) block came first: AS [NOT MATERIALIZED] (body) still follows
        while (i < tokens.length && tokens[i]!.kind !== "block") i++;
        i++;
      }
      if (tokens[i]?.kind === "punct") { i++; continue; }
      break;
    }
    verb = tokens[i]?.kind === "word" ? tokens[i]!.text : "";
    if (!verb) throw fail("invalid_input", "A WITH clause needs a statement after it.");
    if (verb === "WITH") return { kind: "refused", verb };
  }
  if (verb === "EXPLAIN") {
    // EXPLAIN plans without running; EXPLAIN ANALYZE runs the statement.
    const planned = tokens[i + 1]?.text === "ANALYZE" ? tokens[i + 2]?.text : tokens[i + 1]?.text;
    if (planned && !READ_VERBS.has(planned)) return { kind: "refused", verb: planned };
    return { kind: "read", materialisable: false };
  }
  if (READ_VERBS.has(verb)) return { kind: "read", materialisable: withClause || MATERIALISABLE.has(verb) };
  if (verb === "CREATE") {
    let j = i + 1;
    if (tokens[j]?.text === "OR" && tokens[j + 1]?.text === "REPLACE") j += 2;
    if (tokens[j]?.text === "TEMP" || tokens[j]?.text === "TEMPORARY") j++;
    const object = tokens[j]?.text;
    if (object !== "TABLE" && object !== "VIEW") return { kind: "refused", verb: `CREATE ${object ?? ""}`.trim() };
    j++;
    if (tokens[j]?.text === "IF" && tokens[j + 1]?.text === "NOT" && tokens[j + 2]?.text === "EXISTS") j += 3;
    const nameParts: string[] = [];
    while (j < tokens.length && tokens[j]!.kind !== "block" && tokens[j]!.text !== "AS") { nameParts.push(tokens[j]!.raw.replace(/\.$/, "")); j++; }
    if (tokens[j]?.kind === "block") j++; // (col list) before AS
    if (tokens[j]?.text !== "AS" || !nameParts.length) {
      return { kind: "refused", verb: `CREATE ${object}` };
    }
    return { kind: "create", target: nameParts.join(".") };
  }
  return { kind: "refused", verb };
}

/** Throws write_refused for anything but a read (and, when allowed, a
 * CREATE … AS); returns the class for the caller to branch on. */
export function gateSql(sql: string, options: { allowCreate?: boolean } = {}): Exclude<SqlClass, { kind: "refused" }> {
  const kind = classifySql(sql);
  if (kind.kind === "refused") {
    throw fail("write_refused", `${kind.verb} is not allowed here.`, {
      sql,
      hint: options.allowCreate
        ? "Only SELECT-like statements and CREATE [OR REPLACE] TABLE|VIEW … AS … run here. Load data with data_load; export with data_export."
        : "Only SELECT-like statements run here.",
    });
  }
  if (kind.kind === "create" && !options.allowCreate) {
    throw fail("write_refused", "CREATE is not allowed here.", { sql, hint: "Run CREATE TABLE … AS with data_sql, then show or export the table." });
  }
  return kind;
}

// ── bounding ──

const CELL_CHARS_MAX = 2000;

/** Rows for the model: at most `maxRows`, then whole rows dropped from the
 * end until the JSON fits `maxBytes`. A cell longer than CELL_CHARS_MAX is
 * cut so one wide row cannot empty the result. */
export function boundRows(rows: RunResult["rows"], maxRows: number, maxBytes: number): { rows: RunResult["rows"]; truncated: boolean } {
  let truncated = rows.length > maxRows;
  let kept = rows.slice(0, maxRows).map((row) => row.map((cell) => (typeof cell === "string" && cell.length > CELL_CHARS_MAX ? `${cell.slice(0, CELL_CHARS_MAX)}…` : cell)));
  while (kept.length && JSON.stringify(kept).length > maxBytes) {
    kept = kept.slice(0, Math.max(0, kept.length - Math.max(1, Math.ceil(kept.length / 10))));
    truncated = true;
  }
  return { rows: kept, truncated };
}

const trimSample = (sample: string[] | undefined) =>
  sample?.slice(0, DATA_LIMITS.sampleValues).map((value) => (value.length > DATA_LIMITS.sampleChars ? `${value.slice(0, DATA_LIMITS.sampleChars)}…` : value));

/** Columns for the model: samples trimmed, types only past the column cap,
 * then statistics shed in order (samples, min/max, the rest) until the JSON
 * fits `maxBytes`. */
export function boundColumns(columns: DataColumn[], maxBytes: number, columnsMax: number = DATA_LIMITS.describeColumnsMax): { columns: DataColumn[]; truncated: boolean } {
  let truncated = columns.length > columnsMax;
  let kept: DataColumn[] = truncated
    ? columns.map(({ name, type }) => ({ name, type }))
    : columns.map((column) => ({ ...column, ...(column.sample ? { sample: trimSample(column.sample) } : {}) }));
  const size = () => JSON.stringify(kept).length;
  if (size() > maxBytes) { kept = kept.map(({ sample: _sample, ...rest }) => rest); truncated = true; }
  if (size() > maxBytes) kept = kept.map(({ min: _min, max: _max, ...rest }) => rest);
  if (size() > maxBytes) kept = kept.map(({ name, type }) => ({ name, type }));
  while (kept.length && size() > maxBytes) kept = kept.slice(0, Math.max(0, kept.length - Math.max(1, Math.ceil(kept.length / 10))));
  return { columns: kept, truncated };
}

// ── errors ──

/** A hint for the dialect mistakes a model makes most, never a reworded message. */
function hintFor(message: string, sql: string | undefined): string | undefined {
  if (/Parser Error/.test(message) && sql && /"[^"]*\s[^"]*"/.test(sql) && /syntax error at or near/.test(message)) {
    return "Double quotes name identifiers; strings take single quotes.";
  }
  if (/Referenced column .* not found|does not have a column named/.test(message)) return "Check column names with data_describe.";
  if (/Catalog Error.*(Table|View) with name .* does not exist/.test(message)) return "SHOW TABLES lists what is loaded; data_load adds a file or URL.";
  if (/No function matches|Could not choose a best candidate/.test(message)) return "Cast the argument: col::DOUBLE, or try_cast(col AS DATE).";
  if (/Conversion Error/.test(message)) return "Use try_cast(…) in the query, or all_varchar when loading.";
  return undefined;
}

/** Any thrown value as the structured error a tool or route returns. */
export function toDataError(error: unknown, sql?: string, signal?: AbortSignal): DataError {
  if (error instanceof DataFailure) return { ...error.error, ...(sql && !error.error.sql ? { sql } : {}) };
  const message = error instanceof Error ? error.message : String(error);
  if (signal?.aborted || (error instanceof Error && error.name === "AbortError") || /\binterrupt(ed)?\b/i.test(message)) {
    return { code: "cancelled", message: "The statement was cancelled.", ...(sql ? { sql } : {}) };
  }
  if (/timed out|timeout/i.test(message)) return { code: "timeout", message, retryable: true, ...(sql ? { sql } : {}) };
  const line = /LINE (\d+):/.exec(message);
  const hint = hintFor(message, sql);
  return { code: "sql_error", message, ...(sql ? { sql } : {}), ...(line ? { line: Number(line[1]) } : {}), ...(hint ? { hint } : {}) };
}

// ── the context the operations run in ──

export interface DataContext {
  database: BotDatabase;
  sheet: DataSheetStore;
  compileChart: ChartCompiler;
  validateVegaLite: VegaLiteValidator;
  renderer: ChartRenderer;
  /** Folders an export may land in, most preferred first: the bot's working
   * folder, then the person's Downloads. Both may be absent on a Cloud home. */
  exportRoots: () => string[];
  signal: AbortSignal;
  /** The bot's connection for tool calls, the panel's for the person. */
  connection: DataConnection;
  by: DataCard["by"];
}

const runOptions = (ctx: DataContext, extra: Partial<RunOptions> = {}): RunOptions =>
  ({ connection: ctx.connection, signal: ctx.signal, timeoutMs: DATA_LIMITS.sqlTimeoutMs, ...extra });

// ── data_load ──

export type LoadKind = "auto" | "csv" | "tsv" | "parquet" | "json" | "xlsx" | "sqlite" | "folder" | "url" | "postgres" | "mysql" | "gsheet";
export interface LoadInput {
  source: string;
  name?: string;
  kind?: LoadKind;
  sheet?: string;
  replace?: boolean;
  options?: { header?: boolean; delimiter?: string; union_by_name?: boolean; all_varchar?: boolean; ignore_errors?: boolean; sample_size?: number };
}

/** One table the load will create: the reader expression and its name. */
export interface LoadPlan {
  kind: DataSource["kind"];
  /** What the sheet records: the path or URL with credentials removed. */
  source: string;
  /** Default table name before uniqueness. */
  stem: string;
  /** A relation expression (`read_csv(…)`) for file-like sources. */
  reader?: string;
  /** For databases: ATTACH options and which tables to snapshot. */
  attach?: { type: "postgres" | "mysql" | "sqlite"; connection: string; table?: string };
  warnings: string[];
}

const GLOB_CHARS = /[*?[\]]/;
const COMPRESSION = /\.(gz|zst|zstd|bz2)$/i;

/** The DuckDB reader for an extension, or null for one no reader handles. */
function readerFor(ext: string, kind: LoadKind | undefined): "csv" | "tsv" | "json" | "parquet" | "xlsx" | "sqlite" | null {
  if (kind && kind !== "auto" && kind !== "folder" && kind !== "url" && kind !== "gsheet" && kind !== "postgres" && kind !== "mysql") return kind;
  switch (ext.toLowerCase()) {
    case ".csv": return "csv";
    case ".tsv": case ".tab": return "tsv";
    case ".txt": return "csv";
    case ".json": case ".ndjson": case ".jsonl": return "json";
    case ".parquet": case ".pq": return "parquet";
    case ".xlsx": return "xlsx";
    case ".db": case ".sqlite": case ".sqlite3": return "sqlite";
    default: return null;
  }
}

const extensionOf = (path: string) => extname(path.replace(COMPRESSION, ""));
const stemOf = (path: string) => basename(path.replace(COMPRESSION, ""), extensionOf(path));

function csvOptions(options: LoadInput["options"], extra: Record<string, string> = {}): string {
  const parts: string[] = [];
  if (options?.header !== undefined) parts.push(`header=${options.header}`);
  if (options?.delimiter !== undefined) parts.push(`delim=${quoteLiteral(options.delimiter)}`);
  if (options?.union_by_name !== undefined) parts.push(`union_by_name=${options.union_by_name}`);
  if (options?.all_varchar !== undefined) parts.push(`all_varchar=${options.all_varchar}`);
  if (options?.ignore_errors !== undefined) parts.push(`ignore_errors=${options.ignore_errors}`);
  if (options?.sample_size !== undefined) parts.push(`sample_size=${Math.trunc(options.sample_size)}`);
  for (const [key, value] of Object.entries(extra)) if (!parts.some((part) => part.startsWith(`${key}=`))) parts.push(`${key}=${value}`);
  return parts.length ? `, ${parts.join(", ")}` : "";
}

/** One path, or a list of globs, as DuckDB's readers take them. */
function readerExpression(reader: "csv" | "tsv" | "json" | "parquet" | "xlsx", target: string | string[], input: LoadInput, many: boolean): string {
  const path = Array.isArray(target) ? `[${target.map(quoteLiteral).join(", ")}]` : quoteLiteral(target);
  const multi: Record<string, string> = many ? { union_by_name: "true", filename: "true" } : {};
  switch (reader) {
    case "csv": return `read_csv(${path}${csvOptions(input.options, multi)})`;
    case "tsv": return `read_csv(${path}${csvOptions({ ...input.options, delimiter: input.options?.delimiter ?? "\t" }, multi)})`;
    case "json": return `read_json_auto(${path}${many ? ", union_by_name=true, filename=true" : ""}${input.options?.ignore_errors ? ", ignore_errors=true" : ""})`;
    case "parquet": return `read_parquet(${path}${many ? ", union_by_name=true, filename=true" : ""})`;
    case "xlsx": {
      const parts = [path];
      if (input.sheet) parts.push(`sheet=${quoteLiteral(input.sheet)}`);
      if (input.options?.header !== undefined) parts.push(`header=${input.options.header}`);
      if (input.options?.all_varchar !== undefined) parts.push(`all_varchar=${input.options.all_varchar}`);
      return `read_xlsx(${parts.join(", ")})`;
    }
  }
}

/** The source with every credential removed, as the sheet records it and
 * as any error text repeats it. Userinfo passwords, `password=` in a DSN,
 * and query parameters that carry tokens or signatures all go. */
export function stripCredentials(source: string): string {
  const dsn = source.replace(/\b(password|passwd|pwd|sslpassword)\s*=\s*('[^']*'|\S+)/gi, "$1=***");
  try {
    const url = new URL(dsn);
    if (url.password) url.password = "";
    const params = [...url.searchParams.keys()];
    for (const key of params) {
      if (/token|key|secret|password|passwd|pwd|sig|signature|credential|auth|^x-amz-/i.test(key)) url.searchParams.set(key, "***");
    }
    return url.href;
  } catch {
    return dsn.replace(/:\/\/([^/@:]+):[^@/]*@/, "://$1@");
  }
}

/** A table name from a file or sheet name: lowercase letters, digits and
 * underscores, starting with a letter, at most 63 characters. */
export function tableNameFrom(stem: string): string {
  let name = stem.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 63);
  if (!name) name = "data";
  if (!/^[a-z_]/.test(name)) name = `t_${name}`.slice(0, 63);
  return name;
}

/** Where `source` leads and how DuckDB reads it. Local paths are checked
 * here so a missing file is `source_not_found` before any SQL runs. */
export function planLoad(input: LoadInput): LoadPlan[] {
  const { source } = input;
  const kind = input.kind ?? "auto";
  const warnings: string[] = [];
  const gsheet = /^https?:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(source);
  if (kind === "gsheet" || (kind === "auto" && gsheet)) {
    if (!gsheet) throw fail("source_unsupported", "A Google Sheets URL looks like https://docs.google.com/spreadsheets/d/<id>/….");
    const gid = /[?#&]gid=(\d+)/.exec(source)?.[1] ?? (input.sheet && /^\d+$/.test(input.sheet) ? input.sheet : undefined);
    const exportUrl = `https://docs.google.com/spreadsheets/d/${gsheet[1]}/export?format=csv${gid ? `&gid=${gid}` : ""}`;
    warnings.push("Loaded through the sheet's public CSV export; the sheet must be shared with anyone who has the link.");
    return [{ kind: "gsheet", source: stripCredentials(source), stem: input.name ?? "sheet", reader: `read_csv(${quoteLiteral(exportUrl)}${csvOptions(input.options)})`, warnings }];
  }
  const database = /^(postgres(ql)?|mysql):\/\//i.exec(source);
  if (kind === "postgres" || kind === "mysql" || (kind === "auto" && database)) {
    const type = kind === "mysql" || /^mysql/i.test(source) ? "mysql" : "postgres";
    return [{ kind: type, source: stripCredentials(source), stem: input.name ?? type, attach: { type, connection: source, table: input.sheet }, warnings }];
  }
  if (/^(https?|s3|gs|az|azure|r2|hf):\/\//i.test(source) || kind === "url") {
    const pathname = (() => { try { return new URL(source).pathname; } catch { return source; } })();
    const reader = readerFor(extensionOf(pathname), kind === "url" ? undefined : kind);
    if (!reader || reader === "sqlite") throw fail("source_unsupported", `No reader for ${extensionOf(pathname) || "a URL without a file extension"}.`, { hint: "Pass kind: csv, tsv, json, parquet or xlsx." });
    return [{ kind: "url", source: stripCredentials(source), stem: input.name ?? (stemOf(pathname) || "download"), reader: readerExpression(reader, source, input, false), warnings }];
  }
  const local = source.startsWith("~/") || source === "~" ? join(homedir(), source.slice(1)) : source;
  if (GLOB_CHARS.test(local) || (kind === "folder" && !existsSync(local))) {
    const reader = readerFor(extensionOf(local), kind === "folder" ? undefined : kind);
    if (!reader || reader === "sqlite" || reader === "xlsx") throw fail("source_unsupported", "A glob needs a file extension DuckDB reads many of: *.csv, *.parquet, *.json.", { hint: "Pass kind: csv, json or parquet with the glob." });
    return [{ kind: "folder", source: local, stem: input.name ?? (basename(dirname(local)) || "files"), reader: readerExpression(reader, local, input, true), warnings }];
  }
  let stat;
  try { stat = statSync(local); } catch { throw fail("source_not_found", `${local} does not exist.`); }
  if (stat.isDirectory()) {
    // One table per file family found: every csv together, every parquet together, …
    const families = new Map<"csv" | "tsv" | "json" | "parquet", Set<string>>();
    for (const entry of readdirSync(local, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const reader = readerFor(extensionOf(entry.name), undefined);
      if (!reader || reader === "sqlite" || reader === "xlsx") continue;
      (families.get(reader) ?? families.set(reader, new Set()).get(reader)!).add(extensionOf(entry.name).toLowerCase());
    }
    if (!families.size) throw fail("source_unsupported", `${local} holds no csv, tsv, json or parquet files.`);
    const stem = input.name ?? basename(local);
    // DuckDB globs take forward slashes on every platform and no braces: one glob per extension.
    const folder = local.replace(/\\/g, "/");
    return [...families.entries()].map(([reader, exts]) => {
      const globs = [...exts].map((ext) => `${folder}/**/*${ext}`);
      return { kind: "folder" as const, source: local, stem: families.size === 1 ? stem : `${stem}_${reader}`, reader: readerExpression(reader, globs.length === 1 ? globs[0]! : globs, input, true), warnings };
    });
  }
  const reader = readerFor(extensionOf(local), kind);
  if (!reader) throw fail("source_unsupported", `No reader for ${extensionOf(local) || "a file without an extension"}.`, { hint: "Pass kind: csv, tsv, json, parquet, xlsx or sqlite." });
  if (reader === "sqlite") return [{ kind: "sqlite", source: local, stem: input.name ?? stemOf(local), attach: { type: "sqlite", connection: local, table: input.sheet }, warnings }];
  if (reader === "xlsx" && !input.sheet) warnings.push("Loaded the workbook's first sheet; pass sheet to load another.");
  if (extensionOf(local).toLowerCase() === ".txt") warnings.push("Read as CSV; pass options.delimiter if the columns did not split.");
  return [{ kind: reader === "tsv" ? "csv" : reader, source: local, stem: input.name ?? (input.sheet ? `${stemOf(local)}_${input.sheet}` : stemOf(local)), reader: readerExpression(reader, local, input, false), warnings }];
}

const DATABASE_TABLES_MAX = 25;

export interface LoadedTable { name: string; rowCount: number; columns: DataColumn[]; source: string }
export interface LoadOutput { tables: LoadedTable[]; warnings: string[]; elapsedMs: number }

/** Loads every table the plan names, describes each, records each source. */
export async function loadData(ctx: DataContext, input: LoadInput): Promise<LoadOutput> {
  const started = Date.now();
  const plans = planLoad(input);
  const replace = input.replace !== false;
  const existing = new Set((await ctx.database.listTables()).map((table) => table.name.toLowerCase()));
  // The plan already applied `name`; here the stem becomes a valid, unused identifier.
  const unique = (base: string): string => {
    const stem = tableNameFrom(base);
    let name = stem;
    for (let n = 2; !replace && existing.has(name.toLowerCase()); n++) name = `${stem}_${n}`.slice(0, 63);
    existing.add(name.toLowerCase());
    return name;
  };
  const tables: LoadedTable[] = [];
  const warnings: string[] = [];
  const create = async (name: string, relation: string, plan: LoadPlan, options: Record<string, string | number | boolean>) => {
    const sql = `CREATE ${replace ? "OR REPLACE " : ""}TABLE ${quoteIdent(name)} AS SELECT * FROM ${relation}`;
    await ctx.database.run(sql, runOptions(ctx));
    const described = await ctx.database.describe(quoteIdent(name), runOptions(ctx));
    const columns = boundColumns(described.columns, DATA_LIMITS.describeBytesMax, 200).columns;
    ctx.sheet.recordSource({ name, kind: plan.kind, source: plan.source, options, rowCount: described.rowCount, columns, loadedAt: new Date().toISOString() });
    tables.push({ name, rowCount: described.rowCount, columns, source: plan.source });
  };
  const recordedOptions = (plan: LoadPlan): Record<string, string | number | boolean> => ({
    ...(input.sheet ? { sheet: input.sheet } : {}),
    ...(plan.attach?.table ? { table: plan.attach.table } : {}),
    ...Object.fromEntries(Object.entries(input.options ?? {}).filter(([, value]) => value !== undefined)) as Record<string, string | number | boolean>,
  });
  for (const plan of plans) {
    warnings.push(...plan.warnings);
    if (plan.reader) {
      await create(unique(plan.stem), plan.reader, plan, recordedOptions(plan));
      continue;
    }
    const attach = plan.attach!;
    // A foreign database is attached read-only for the snapshot and detached
    // again whatever happens: the connection string never persists.
    const alias = `omb_src_${Date.now().toString(36)}`;
    await ctx.database.run(`ATTACH ${quoteLiteral(attach.connection)} AS ${quoteIdent(alias)} (TYPE ${attach.type}, READ_ONLY)`, runOptions(ctx));
    try {
      let chosen: Array<{ schema: string; table: string }>;
      if (attach.table) {
        const parts = attach.table.split(".");
        chosen = [parts.length > 1 ? { schema: parts[0]!, table: parts.slice(1).join(".") } : { schema: "", table: attach.table }];
      } else {
        const listed = await ctx.database.run(
          `SELECT schema_name, table_name FROM duckdb_tables() WHERE database_name = ${quoteLiteral(alias)} AND NOT internal AND schema_name NOT IN ('information_schema', 'pg_catalog', 'mysql', 'performance_schema', 'sys') ORDER BY schema_name, table_name`,
          runOptions(ctx, { maxRows: DATABASE_TABLES_MAX + 1 }),
        );
        chosen = listed.rows.map((row) => ({ schema: String(row[0]), table: String(row[1]) }));
        if (chosen.length > DATABASE_TABLES_MAX) {
          throw fail("invalid_input", `${plan.source} has more than ${DATABASE_TABLES_MAX} tables.`, { hint: `Pass sheet with one of: ${chosen.slice(0, DATABASE_TABLES_MAX).map((entry) => `${entry.schema}.${entry.table}`).join(", ")}.` });
        }
        if (!chosen.length) throw fail("source_unsupported", `${plan.source} has no tables to load.`);
      }
      // One table keeps the bot's name (or the source table's); several keep their own names.
      for (const entry of chosen) {
        const relation = entry.schema ? `${quoteIdent(alias)}.${quoteIdent(entry.schema)}.${quoteIdent(entry.table)}` : `${quoteIdent(alias)}.${quoteIdent(entry.table)}`;
        const name = unique(chosen.length > 1 ? entry.table : input.name ?? entry.table);
        await create(name, relation, plan, { ...recordedOptions(plan), table: entry.schema ? `${entry.schema}.${entry.table}` : entry.table });
      }
    } finally {
      await ctx.database.run(`DETACH ${quoteIdent(alias)}`, { connection: ctx.connection }).catch(() => {});
    }
  }
  return { tables, warnings, elapsedMs: Date.now() - started };
}

// ── data_describe ──

const IDENTIFIER_LIKE = /^\s*("[^"]+"|[A-Za-z_][\w$]*)(\.("[^"]+"|[A-Za-z_][\w$]*)){0,2}\s*$/;

export interface DescribeOutput { name?: string; sql?: string; rowCount: number; columns: DataColumn[]; truncated?: boolean; elapsedMs: number }

/** A table by name, or a SELECT's result as `(sql)`: the one relation form
 * the engine's describe takes for both. */
export async function describeTarget(ctx: DataContext, target: string): Promise<DescribeOutput> {
  const started = Date.now();
  let relation: string;
  let name: string | undefined;
  let sql: string | undefined;
  if (IDENTIFIER_LIKE.test(target)) {
    name = await ctx.database.resolveTable(target.trim());
    relation = name;
  } else {
    const kind = gateSql(target);
    if (kind.kind !== "read" || !kind.materialisable) throw fail("invalid_input", "Describe takes a table name or a SELECT.", { sql: target });
    sql = target;
    relation = `(${target})`;
  }
  const described = await ctx.database.describe(relation, runOptions(ctx));
  const { columns, truncated } = boundColumns(described.columns, DATA_LIMITS.describeBytesMax);
  return { ...(name ? { name } : {}), ...(sql ? { sql } : {}), rowCount: described.rowCount, columns, ...(truncated ? { truncated } : {}), elapsedMs: Date.now() - started };
}

// ── data_sql ──

export interface SqlInput { sql: string; limit?: number; name?: string }
export interface SqlOutput {
  /** The result table (omb_results.q_<n>), the created table, or null for metadata statements. */
  table: string | null;
  columns: DataColumn[];
  rowCount: number;
  rows: RunResult["rows"];
  truncated: boolean;
  elapsedMs: number;
}

export async function runSql(ctx: DataContext, input: SqlInput): Promise<SqlOutput> {
  const started = Date.now();
  const limit = Math.min(Math.max(1, Math.trunc(input.limit ?? DATA_LIMITS.sqlRowsDefault)), DATA_LIMITS.sqlRowsMax);
  const kind = gateSql(input.sql, { allowCreate: true });
  if (kind.kind === "create") {
    await ctx.database.run(input.sql, runOptions(ctx));
    const described = await ctx.database.describe(kind.target, runOptions(ctx));
    return { table: kind.target, columns: boundColumns(described.columns, DATA_LIMITS.describeBytesMax).columns, rowCount: described.rowCount, rows: [], truncated: false, elapsedMs: Date.now() - started };
  }
  if (!kind.materialisable) {
    const result = await ctx.database.run(input.sql, runOptions(ctx, { maxRows: limit + 1 }));
    const bounded = boundRows(result.rows, limit, DATA_LIMITS.sqlBytesMax);
    return { table: null, columns: result.columns, rowCount: result.rowCount, rows: bounded.rows, truncated: bounded.truncated || result.truncated, elapsedMs: Date.now() - started };
  }
  const name = input.name ? tableNameFrom(input.name) : ctx.sheet.nextResultName();
  const materialised = await ctx.database.materialise(input.sql, name, runOptions(ctx));
  const page = await ctx.database.run(`SELECT * FROM ${materialised.table} LIMIT ${limit + 1}`, runOptions(ctx, { maxRows: limit + 1 }));
  const bounded = boundRows(page.rows, limit, DATA_LIMITS.sqlBytesMax);
  return {
    table: materialised.table,
    columns: materialised.columns,
    rowCount: materialised.rowCount,
    rows: bounded.rows,
    truncated: bounded.truncated || materialised.rowCount > bounded.rows.length,
    elapsedMs: Date.now() - started,
  };
}

// ── data_show ──

export interface ShowInput {
  id?: string;
  title?: string;
  sql?: string;
  table?: string;
  kind: "table" | "chart";
  chart?: OmbChartSpec;
  vegaLite?: Record<string, unknown>;
  limit?: number;
}
export interface ShowOutput {
  id: string;
  sheet: Array<{ id: string; title: string; kind: DataCard["kind"] }>;
  rowCount: number;
  truncated?: boolean;
  reduction?: DataReduction;
  warnings: string[];
  elapsedMs: number;
}

const OUTPUT_TOO_LARGE_HINT = "Aggregate or filter in SQL (GROUP BY, date_trunc, LIMIT) so the chart draws fewer marks.";

/** One tool call = one card. A new card appears "running" at once so the
 * person sees the work; an existing id changes in place and keeps its last
 * good result when the new query fails. Throws DataFailure. */
export async function showCard(ctx: DataContext, input: ShowInput): Promise<ShowOutput> {
  const started = Date.now();
  if (Boolean(input.sql) === Boolean(input.table)) throw fail("invalid_input", "Give exactly one of sql or table.");
  if (input.kind === "chart" && Boolean(input.chart) === Boolean(input.vegaLite)) throw fail("invalid_input", "A chart card takes chart (the small spec) or vegaLite, not both and not neither.");
  if (input.kind === "table" && (input.chart || input.vegaLite)) throw fail("invalid_input", "A table card takes no chart spec; use kind \"chart\".");
  let from: string;
  let cardSql: string;
  if (input.sql) {
    const kind = gateSql(input.sql);
    if (kind.kind !== "read" || !kind.materialisable) throw fail("invalid_input", "A card shows a SELECT's result.", { sql: input.sql });
    from = `(${input.sql})`;
    cardSql = input.sql;
  } else {
    // resolveTable returns the identifier as the engine spells it for SQL.
    const resolved = await ctx.database.resolveTable(input.table!);
    from = resolved;
    cardSql = `SELECT * FROM ${resolved}`;
  }
  const title = input.title ?? (input.table ? input.table : input.chart ? `${input.chart.type} of ${input.chart.y ?? "count"} by ${input.chart.x}` : input.kind === "chart" ? "Chart" : "Query");
  let card: DataCard;
  if (input.id) {
    const existing = ctx.sheet.card(input.id);
    if (!existing) throw fail("card_not_found", `No card ${input.id} on the sheet.`, { hint: ctx.sheet.outline().length ? `Cards: ${ctx.sheet.outline().map((entry) => `${entry.id} ${entry.title}`).join(", ")}.` : "The sheet is empty; omit id to add a card." });
    card = ctx.sheet.updateCard(input.id, { kind: input.kind, title: input.title ?? existing.title, sql: cardSql, chart: input.chart, status: "running", error: undefined, by: ctx.by })!;
  } else {
    card = await ctx.sheet.addCard({ kind: input.kind, title, sql: cardSql, chart: input.chart, by: ctx.by });
  }
  const warnings: string[] = [];
  try {
    let patch: Partial<DataCard>;
    if (input.kind === "table") {
      const limit = Math.min(Math.max(1, Math.trunc(input.limit ?? DATA_LIMITS.showTableRowsMax)), DATA_LIMITS.showTableRowsMax);
      const materialised = await ctx.database.materialise(`SELECT * FROM ${from} LIMIT ${limit}`, card.id, runOptions(ctx));
      // Exactly `limit` rows kept means the source may hold more.
      const truncated = materialised.rowCount >= limit;
      if (truncated) warnings.push(`The card keeps the first ${limit.toLocaleString("en-US")} rows.`);
      patch = { result: card.id, columns: materialised.columns, rowCount: materialised.rowCount, truncated, chart: undefined, vegaLite: undefined, reduction: undefined };
    } else if (input.chart) {
      const probe = await ctx.database.run(`SELECT * FROM ${from} LIMIT 0`, runOptions(ctx, { maxRows: 0 }));
      const compiled = ctx.compileChart(input.chart, probe.columns, from);
      const materialised = await ctx.database.materialise(compiled.sql, card.id, runOptions(ctx));
      if (materialised.rowCount > DATA_LIMITS.chartMaxMarks) {
        throw fail("output_too_large", `The chart would draw ${materialised.rowCount.toLocaleString("en-US")} marks; the limit is ${DATA_LIMITS.chartMaxMarks.toLocaleString("en-US")}.`, { sql: compiled.sql, hint: OUTPUT_TOO_LARGE_HINT });
      }
      const counted = await ctx.database.run(`SELECT count(*) FROM ${from}`, runOptions(ctx, { maxRows: 1 }));
      const reduction: DataReduction = { ...compiled.reduction, inputRows: Number(counted.rows[0]?.[0] ?? 0), outputRows: materialised.rowCount };
      patch = { result: card.id, columns: materialised.columns, rowCount: materialised.rowCount, truncated: false, chart: input.chart, vegaLite: compiled.vegaLite, reduction };
    } else {
      const vegaLite = await ctx.validateVegaLite(input.vegaLite);
      const limit = Math.min(Math.max(1, Math.trunc(input.limit ?? DATA_LIMITS.chartMaxMarks)), DATA_LIMITS.chartMaxMarks);
      const materialised = await ctx.database.materialise(`SELECT * FROM ${from} LIMIT ${limit + 1}`, card.id, runOptions(ctx));
      if (materialised.rowCount > limit) {
        throw fail("output_too_large", `The chart would bind more than ${limit.toLocaleString("en-US")} rows.`, { sql: cardSql, hint: OUTPUT_TOO_LARGE_HINT });
      }
      const counted = await ctx.database.run(`SELECT count(*) FROM ${from}`, runOptions(ctx, { maxRows: 1 }));
      const reduction: DataReduction = { method: "none", inputRows: Number(counted.rows[0]?.[0] ?? 0), outputRows: materialised.rowCount };
      patch = { result: card.id, columns: materialised.columns, rowCount: materialised.rowCount, truncated: false, chart: undefined, vegaLite, reduction };
    }
    const ready = ctx.sheet.updateCard(card.id, { ...patch, status: "ready", error: undefined, elapsedMs: Date.now() - started })!;
    return {
      id: ready.id,
      sheet: ctx.sheet.outline(),
      rowCount: ready.rowCount ?? 0,
      ...(ready.truncated ? { truncated: true } : {}),
      ...(ready.reduction ? { reduction: ready.reduction } : {}),
      warnings,
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    const dataError = toDataError(error, cardSql, ctx.signal);
    ctx.sheet.updateCard(card.id, { status: "failed", error: dataError, elapsedMs: Date.now() - started });
    throw new DataFailure(dataError);
  }
}

// ── data_export ──

export interface ExportInput { id?: string; table?: string; sql?: string; format: DataExportFormat; path?: string; theme?: "light" | "dark"; width?: number; scale?: number }
export interface ExportOutput { path: string; bytes: number; rowCount?: number }

const same = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
const isUnder = (child: string, root: string) => same(child, root) || (process.platform === "win32" ? child.toLowerCase().startsWith(`${root.toLowerCase()}${sep}`) : child.startsWith(`${root}${sep}`));

/** The deepest existing ancestor's real path joined with the rest, so a
 * symlink inside an allowed folder cannot lead the file out of it. */
function realIntent(path: string): string {
  let dir = path;
  const rest: string[] = [];
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) return path;
    rest.unshift(basename(dir));
    dir = parent;
  }
  return join(realpathSync.native(dir), ...rest);
}

/** Where an export lands: `requested` (absolute, `~/…`, or relative to the
 * first root) or `<first root>/<stem>.<ext>`, confined to `roots`. Makes
 * the folder. Throws invalid_input for a path outside every root. */
export function resolveExportPath(roots: string[], requested: string | undefined, stem: string, ext: string): string {
  const allowed = roots.filter((root) => root && isAbsolute(root)).map((root) => resolve(root));
  if (!allowed.length) throw fail("invalid_input", "There is no folder to export into on this computer.");
  let target: string;
  if (!requested) {
    target = join(allowed[0]!, `${tableNameFrom(stem)}.${ext}`);
  } else {
    const expanded = requested.startsWith("~/") || requested === "~" ? join(homedir(), requested.slice(1)) : requested;
    target = resolve(isAbsolute(expanded) ? expanded : join(allowed[0]!, expanded));
    if (existsSync(target) && statSync(target).isDirectory()) target = join(target, `${tableNameFrom(stem)}.${ext}`);
    else if (!extname(target)) target = `${target}.${ext}`;
  }
  const intent = realIntent(target);
  if (!allowed.some((root) => isUnder(intent, realIntent(root)))) {
    throw fail("invalid_input", `${requested ?? target} is outside the folders an export may use.`, { hint: `Export into ${allowed.join(" or ")}.` });
  }
  // The same file again gets a numbered name rather than a silent overwrite.
  let unique = target;
  for (let n = 2; existsSync(unique); n++) unique = join(dirname(target), `${basename(target, extname(target))}-${n}${extname(target)}`);
  mkdirSync(dirname(unique), { recursive: true });
  return unique;
}

/** A card's rows as its chart binds them (the reduced result). */
async function chartRows(ctx: DataContext, card: DataCard): Promise<RunResult> {
  if (card.kind !== "chart" || !card.vegaLite || !card.result) throw fail("invalid_input", `${card.id} is not a rendered chart card.`, { hint: "png and svg export a chart card; export data as csv, parquet or xlsx." });
  return ctx.database.run(`SELECT * FROM ${resultRelation(card.result)} LIMIT ${DATA_LIMITS.chartMaxMarks}`, runOptions(ctx, { maxRows: DATA_LIMITS.chartMaxMarks }));
}

/** The image of a chart card, for export, the panel's image route, phones and Slack. */
export async function renderCard(ctx: DataContext, card: DataCard, format: "png" | "svg", options: { theme?: "light" | "dark"; width?: number; scale?: number } = {}): Promise<string | Buffer> {
  const rows = await chartRows(ctx, card);
  const theme = options.theme ?? "light";
  return format === "svg"
    ? ctx.renderer.svg(card.vegaLite!, rows.rows, rows.columns, { theme, width: options.width })
    : ctx.renderer.png(card.vegaLite!, rows.rows, rows.columns, { theme, width: options.width, scale: options.scale });
}

export async function exportData(ctx: DataContext, input: ExportInput): Promise<ExportOutput> {
  const given = [input.id, input.table, input.sql].filter(Boolean).length;
  if (given !== 1) throw fail("invalid_input", "Give exactly one of id, table or sql.");
  const card = input.id ? ctx.sheet.card(input.id) : undefined;
  if (input.id && !card) throw fail("card_not_found", `No card ${input.id} on the sheet.`);
  if (input.format === "png" || input.format === "svg") {
    if (!card) throw fail("invalid_input", "png and svg render a chart card: pass its id.");
    const image = await renderCard(ctx, card, input.format, { theme: input.theme, width: input.width, scale: input.scale });
    const path = resolveExportPath(ctx.exportRoots(), input.path, card.title, input.format);
    writeFileSync(path, image);
    return { path, bytes: statSync(path).size };
  }
  let relation: string;
  let stem: string;
  if (card) {
    if (card.result) relation = resultRelation(card.result);
    else if (card.sql) relation = `(${card.sql})`;
    else throw fail("invalid_input", `${card.id} has no data to export.`);
    stem = card.title;
  } else if (input.table) {
    relation = await ctx.database.resolveTable(input.table);
    stem = input.table;
  } else {
    const kind = gateSql(input.sql!);
    if (kind.kind !== "read" || !kind.materialisable) throw fail("invalid_input", "Export takes a SELECT.", { sql: input.sql });
    relation = `(${input.sql})`;
    stem = "query";
  }
  const path = resolveExportPath(ctx.exportRoots(), input.path, stem, input.format);
  const format = input.format === "csv" ? "FORMAT csv, HEADER true" : input.format === "xlsx" ? "FORMAT xlsx, HEADER true" : "FORMAT parquet";
  const copied = await ctx.database.run(`COPY (SELECT * FROM ${relation}) TO ${quoteLiteral(path)} (${format})`, runOptions(ctx, { maxRows: 1 }));
  const count = Number(copied.rows[0]?.[0]);
  return { path, bytes: statSync(path).size, ...(Number.isFinite(count) ? { rowCount: count } : {}) };
}

// ── the MCP face ──

export type DataToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export function dataErrorResult(error: DataError): DataToolResult {
  const text = `${error.code}: ${error.message}${error.line ? ` (line ${error.line})` : ""}${error.hint ? ` Hint: ${error.hint}` : ""}${error.candidates?.length ? ` Did you mean: ${error.candidates.join(", ")}?` : ""}`;
  return { isError: true, content: [{ type: "text", text }], structuredContent: { ...error } };
}

const ok = (structured: Record<string, unknown>): DataToolResult =>
  ({ content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured });

/** One tool call. Arguments are checked against the advertised schema first;
 * every failure after that is a structured DataError the model can act on. */
export async function runDataTool(ctx: DataContext, name: string, args: Record<string, unknown>): Promise<DataToolResult> {
  const problem = dataToolCallProblem(name, args);
  if (problem) return dataErrorResult({ code: "invalid_input", message: problem });
  try {
    ctx.signal.throwIfAborted();
    switch (name) {
      case "data_load": return ok({ ...(await loadData(ctx, args as unknown as LoadInput)) });
      case "data_describe": return ok({ ...(await describeTarget(ctx, (args as { target: string }).target)) });
      case "data_sql": return ok({ ...(await runSql(ctx, args as unknown as SqlInput)) });
      case "data_show": return ok({ ...(await showCard(ctx, args as unknown as ShowInput)) });
      case "data_export": return ok({ ...(await exportData(ctx, args as unknown as ExportInput)) });
      default: return dataErrorResult({ code: "invalid_input", message: "Unknown Data tool." });
    }
  } catch (error) {
    return dataErrorResult(toDataError(error, typeof args.sql === "string" ? args.sql : undefined, ctx.signal));
  }
}
