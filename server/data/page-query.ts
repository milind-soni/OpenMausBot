// A bot's page reads its bot's database through mausbot.data.query. The instance is shared with the bot's own tools, which
// load files and URLs, so its external access stays on; what keeps a page's SQL away from files, the network and
// writes is this gate, every step of it judged by DuckDB itself, never by reading the text:
//
// 1. DuckDB splits the text: exactly one statement.
// 2. DuckDB's own parser serializes it (json_serialize_sql serializes only a SELECT) and the tree is walked before
//    anything binds (binding a file reader already opens the file): table functions only from PURE_TABLE_FUNCTIONS,
//    every table a table or view of this database (or, by a plain name, a CTE the reference can see: an earlier one, or
//    itself from a recursive one's recursive side), so neither a file path nor a built-in view can pass as one,
//    and no function from SETTINGS_FUNCTIONS.
// 3. DuckDB prepares it and names its type: SELECT only.
// 4. It runs inside a read-only transaction, which DuckDB refuses to write the database file from.
//
// Security: views and macros the bot made run as the bot wrote them, so one the bot made over a file reads that file.
import type * as DuckDB from "@duckdb/node-api";

import { DATA_RESULTS_SCHEMA } from "../../shared/data-surface.ts";
import { DataFailure } from "./types.ts";

export type PageQueryParams = unknown[] | Record<string, unknown>;

const PURE_TABLE_FUNCTIONS = new Set(["range", "generate_series", "unnest"]);
const SETTINGS_FUNCTIONS = new Set(["current_setting", "write_log", "nextval", "setseed", "getvariable"]);
const READABLE_SCHEMAS = new Set(["main", DATA_RESULTS_SCHEMA]);
const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TABLE_REFS = new Set(["BASE_TABLE", "SUBQUERY", "JOIN", "EXPRESSION_LIST", "TABLE_FUNCTION", "EMPTY", "EMPTY_FROM", "PIVOT"]);

export const PAGE_QUERY_HINT = "A page runs one SELECT on its bot's own tables and views.";

const refuse = (message: string, sql: string) => new DataFailure({ code: "write_refused", message, sql, hint: PAGE_QUERY_HINT });

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

type Catalog = { tables: Set<string>; unqualified: Set<string> };

async function catalogOf(conn: DuckDB.DuckDBConnection): Promise<Catalog> {
  const reader = await conn.runAndReadAll(
    "SELECT schema_name, table_name FROM duckdb_tables() WHERE database_name = current_database() AND NOT internal " +
    "UNION ALL SELECT schema_name, view_name FROM duckdb_views() WHERE database_name = current_database() AND NOT internal");
  const tables = new Set<string>();
  const unqualified = new Set<string>();
  for (const [schema, name] of reader.getRowsJson() as Array<[string, string]>) {
    const schemaName = String(schema).toLowerCase();
    if (!READABLE_SCHEMAS.has(schemaName)) continue;
    tables.add(`${schemaName}.${String(name).toLowerCase()}`);
    if (schemaName === "main") unqualified.add(String(name).toLowerCase());
  }
  return { tables, unqualified };
}

/** Throws write_refused at the first thing in the parsed tree a page may not reach. */
export function checkPageTree(tree: unknown, catalog: Catalog, database: string, sql: string): void {
  const visit = (node: unknown, ctes: ReadonlySet<string>): void => {
    if (Array.isArray(node)) { for (const item of node) visit(item, ctes); return; }
    if (!isRecord(node)) return;
    const map = isRecord(node.cte_map) && Array.isArray(node.cte_map.map) ? node.cte_map.map : [];
    // A CTE's body sees the CTEs before it, and itself only from the recursive side of a recursive one; the query sees all.
    let scope = new Set(ctes);
    for (const entry of map) {
      const name = isRecord(entry) && typeof entry.key === "string" && PLAIN_NAME.test(entry.key) ? entry.key.toLowerCase() : null;
      const body = isRecord(entry) && isRecord(entry.value) && isRecord(entry.value.query) ? entry.value.query.node : undefined;
      if (isRecord(body) && body.type === "RECURSIVE_CTE_NODE" && name) {
        const own = new Set(scope).add(name);
        for (const [key, value] of Object.entries(body)) visit(value, key === "left" ? scope : own);
      } else visit(entry, scope);
      if (name) scope = new Set(scope).add(name);
    }
    if (node.class === "FUNCTION" && typeof node.function_name === "string" && SETTINGS_FUNCTIONS.has(node.function_name.toLowerCase())) {
      throw refuse(`${node.function_name}() cannot run from a page.`, sql);
    }
    const tableRef = typeof node.type === "string" && node.class === undefined && "alias" in node && "sample" in node;
    if (tableRef) {
      const type = node.type as string;
      if (!TABLE_REFS.has(type)) throw refuse(`A page cannot read ${type.toLowerCase().replace(/_/g, " ")}.`, sql);
      if (type === "TABLE_FUNCTION") {
        const name = isRecord(node.function) && typeof node.function.function_name === "string" ? node.function.function_name : "";
        if (!PURE_TABLE_FUNCTIONS.has(name.toLowerCase())) throw refuse(`${name || "That table function"}() cannot run from a page: files, URLs and settings stay out of its reach.`, sql);
      }
      if (type === "BASE_TABLE") checkTable(node, scope);
    }
    for (const [key, value] of Object.entries(node)) if (key !== "cte_map") visit(value, scope);
  };
  const checkTable = (node: Record<string, unknown>, ctes: ReadonlySet<string>) => {
    const name = String(node.table_name ?? "").toLowerCase();
    const schema = String(node.schema_name ?? "").toLowerCase();
    const catalogName = String(node.catalog_name ?? "").toLowerCase();
    const shown = [catalogName, schema, name].filter(Boolean).join(".");
    if (catalogName && catalogName !== database.toLowerCase()) throw refuse(`${shown} is not in this bot's database.`, sql);
    if (!schema) {
      if (ctes.has(name) || catalog.unqualified.has(name)) return;
    } else if (catalog.tables.has(`${schema}.${name}`)) return;
    throw refuse(`${shown} is not a table or view in this bot's database.`, sql);
  };
  visit(tree, new Set());
}

/** The prepared statement of a page's query, once it has passed every step but the transaction. */
export async function preparePageQuery(binding: typeof DuckDB, conn: DuckDB.DuckDBConnection, sql: string, params: PageQueryParams | undefined): Promise<DuckDB.DuckDBPreparedStatement> {
  const extracted = await conn.extractStatements(sql);
  if (extracted.count !== 1) throw refuse("One statement per query.", sql);
  const parsed = await conn.runAndReadAll("SELECT json_serialize_sql($1::VARCHAR), current_database()", [sql]);
  const [text, database] = parsed.getRowsJson()[0] as [string, string];
  let tree: unknown;
  try { tree = JSON.parse(text); } catch { throw refuse("DuckDB could not read that query.", sql); }
  if (!isRecord(tree) || tree.error === true) {
    const why = isRecord(tree) && typeof tree.error_message === "string" ? tree.error_message : "";
    throw /only select/i.test(why) ? refuse("Only a SELECT can run from a page.", sql) : new DataFailure({ code: "sql_error", message: why || "DuckDB could not read that query.", sql });
  }
  checkPageTree(tree.statements, await catalogOf(conn), String(database), sql);
  const prepared = await extracted.prepare(0);
  if (prepared.statementType !== binding.StatementType.SELECT) throw refuse("Only a SELECT can run from a page.", sql);
  if (params !== undefined) prepared.bind(params as DuckDB.DuckDBValue[] | Record<string, DuckDB.DuckDBValue>);
  return prepared;
}
