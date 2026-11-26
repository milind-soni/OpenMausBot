// One app's own SQLite file, in a process of its own. node:sqlite runs a statement synchronously and has no interrupt
// (Node 24.18: no progress handler, and Worker.terminate() waits for the statement to finish), so the only way to stop a
// runaway statement is to kill the process that runs it; SQLite then rolls back the unfinished transaction on next open.
//
// Security: what a statement may touch is decided by SQLite itself, never by reading the SQL text:
// - `read` statements run on a connection opened readOnly, with PRAGMA query_only, and an authorizer that denies writes;
// - every connection has attach=0 (no ATTACH, which also stops VACUUM INTO), extension loading off, defensive mode, and an
//   authorizer that denies PRAGMA, ATTACH/DETACH, transaction control and load_extension();
// - DDL is allowed only while migrations run.
import { DatabaseSync, constants as C, type StatementSync } from "node:sqlite";

type Role = "read" | "write" | "migrate";
type Params = unknown[] | Record<string, unknown> | undefined;

interface Migration { version: number; name: string; sql: string }
interface Limits { rows: number; bytes: number }

type Request =
  | { id: number; op: "open"; file: string; migrations: Migration[]; limits: Limits }
  | { id: number; op: "query"; sql: string; params?: Params; mode: "read" | "write" }
  | { id: number; op: "exec"; sql: string; params?: Params }
  | { id: number; op: "begin" | "commit" | "rollback" | "close" };

const BLOCKED_FUNCTIONS = new Set(["load_extension", "fts3_tokenizer", "sqlite_offset"]);
const WRITE_ACTIONS = new Set([C.SQLITE_INSERT, C.SQLITE_UPDATE, C.SQLITE_DELETE]);
const DDL_ACTIONS = new Set([
  C.SQLITE_CREATE_INDEX, C.SQLITE_CREATE_TABLE, C.SQLITE_CREATE_TRIGGER, C.SQLITE_CREATE_VIEW,
  C.SQLITE_DROP_INDEX, C.SQLITE_DROP_TABLE, C.SQLITE_DROP_TRIGGER, C.SQLITE_DROP_VIEW,
  C.SQLITE_ALTER_TABLE, C.SQLITE_REINDEX, C.SQLITE_ANALYZE,
]);

let writer: DatabaseSync | null = null;
let reader: DatabaseSync | null = null;
let limits: Limits = { rows: 5000, bytes: 1_000_000 };
let writerRole: Role = "write";
/** True only while this process runs its own statements (BEGIN, COMMIT, PRAGMA user_version). */
let hostStatement = false;
let inTransaction = false;

function authorizer(role: () => Role) {
  return (action: number, arg1: string | null, arg2: string | null, database: string | null): number => {
    if (hostStatement) return C.SQLITE_OK;
    if (database !== null && database !== "main" && database !== "temp") return C.SQLITE_DENY;
    switch (action) {
      case C.SQLITE_SELECT:
      case C.SQLITE_READ:
      case C.SQLITE_RECURSIVE:
        return C.SQLITE_OK;
      case C.SQLITE_FUNCTION:
        return BLOCKED_FUNCTIONS.has(String(arg2 ?? "").toLowerCase()) ? C.SQLITE_DENY : C.SQLITE_OK;
      default:
        if (WRITE_ACTIONS.has(action)) {
          const table = String(arg1 ?? "").toLowerCase();
          if (role() === "read") return C.SQLITE_DENY;
          return role() === "migrate" || !table.startsWith("sqlite_") || table === "sqlite_sequence" ? C.SQLITE_OK : C.SQLITE_DENY;
        }
        if (DDL_ACTIONS.has(action)) return role() === "migrate" ? C.SQLITE_OK : C.SQLITE_DENY;
        return C.SQLITE_DENY;
    }
  };
}

function openConnection(file: string, readOnly: boolean, role: () => Role): DatabaseSync {
  const db = new DatabaseSync(file, { readOnly, allowExtension: false, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, limits: { attach: 0, length: 10_000_000, sqlLength: 100_000 } } as ConstructorParameters<typeof DatabaseSync>[1]);
  if (typeof (db as { enableDefensive?: (on: boolean) => void }).enableDefensive === "function") (db as unknown as { enableDefensive(on: boolean): void }).enableDefensive(true);
  if (readOnly) db.exec("PRAGMA query_only = ON");
  else db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY");
  db.exec("PRAGMA trusted_schema = OFF");
  if (typeof (db as { setAuthorizer?: unknown }).setAuthorizer !== "function") {
    throw new Error("This runtime's node:sqlite has no setAuthorizer; app databases need it.");
  }
  (db as unknown as { setAuthorizer(fn: unknown): void }).setAuthorizer(authorizer(role));
  return db;
}

function host<T>(work: () => T): T {
  hostStatement = true;
  try { return work(); } finally { hostStatement = false; }
}

function migrate(db: DatabaseSync, migrations: Migration[]): number[] {
  const current = Number((host(() => db.prepare("PRAGMA user_version").get()) as { user_version: number }).user_version);
  if (current > migrations.length) throw Object.assign(new Error(`The app's database is at migration ${current}, newer than the app's ${migrations.length}.`), { code: "migration_newer" });
  const applied: number[] = [];
  for (const migration of migrations.slice(current)) {
    writerRole = "migrate";
    host(() => db.exec("BEGIN IMMEDIATE"));
    try {
      db.exec(migration.sql);
      host(() => db.exec(`PRAGMA user_version = ${migration.version}`));
      host(() => db.exec("COMMIT"));
      applied.push(migration.version);
    } catch (error) {
      host(() => db.exec("ROLLBACK"));
      throw Object.assign(new Error(`Migration ${migration.name} failed: ${(error as Error).message}`), { code: "migration_failed" });
    } finally {
      writerRole = "write";
    }
  }
  return applied;
}

function bindable(value: unknown): unknown {
  if (value === null || typeof value === "number" || typeof value === "string" || typeof value === "bigint") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === undefined) return null;
  throw Object.assign(new Error("SQL parameters are numbers, text, true/false or null."), { code: "invalid_params" });
}

function bind(params: Params): unknown[] {
  if (params === undefined) return [];
  if (Array.isArray(params)) return params.map(bindable);
  return [Object.fromEntries(Object.entries(params).map(([key, value]) => [key, bindable(value)]))];
}

function cell(value: unknown): unknown {
  if (value instanceof Uint8Array) return { base64: Buffer.from(value).toString("base64") };
  if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : String(value);
  return value;
}

function readRows(statement: StatementSync, params: Params) {
  const columns = statement.columns().map((column) => column.name);
  const rows: Record<string, unknown>[] = [];
  let bytes = 2;
  let truncated = false;
  for (const row of statement.iterate(...(bind(params) as []))) {
    if (rows.length >= limits.rows) { truncated = true; break; }
    const shaped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row as Record<string, unknown>)) shaped[key] = cell(value);
    bytes += Buffer.byteLength(JSON.stringify(shaped)) + 1;
    if (bytes > limits.bytes) { truncated = true; break; }
    rows.push(shaped);
  }
  return { columns, rows, truncated };
}

function handle(request: Request): unknown {
  switch (request.op) {
    case "open": {
      limits = request.limits;
      writer = openConnection(request.file, false, () => writerRole);
      const applied = migrate(writer, request.migrations);
      reader = openConnection(request.file, true, () => "read");
      return { applied, version: request.migrations.length };
    }
    case "query": {
      const db = request.mode === "read" ? reader : writer;
      if (!db) throw new Error("The app's database is not open.");
      if (request.mode === "write" && !inTransaction) throw new Error("No change is in progress.");
      return readRows(db.prepare(request.sql), request.params);
    }
    case "exec": {
      if (!writer || !inTransaction) throw Object.assign(new Error("ctx.db.exec runs only inside a change operation."), { code: "read_only" });
      const result = writer.prepare(request.sql).run(...(bind(request.params) as []));
      return { changes: Number(result.changes), lastInsertRowid: cell(result.lastInsertRowid) };
    }
    case "begin":
      if (!writer) throw new Error("The app's database is not open.");
      host(() => writer!.exec("BEGIN IMMEDIATE"));
      inTransaction = true;
      return {};
    case "commit":
    case "rollback":
      if (writer && inTransaction) host(() => writer!.exec(request.op === "commit" ? "COMMIT" : "ROLLBACK"));
      inTransaction = false;
      return {};
    case "close":
      reader?.close();
      writer?.close();
      reader = writer = null;
      setImmediate(() => process.exit(0));
      return {};
  }
}

process.on("message", (message: Request) => {
  let reply: Record<string, unknown>;
  try {
    reply = { id: message.id, ok: true, value: handle(message) };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    reply = { id: message.id, ok: false, error: (error as Error).message, code: typeof code === "string" ? code : "sql_error" };
  }
  process.send?.(reply);
});
process.on("disconnect", () => process.exit(0));
