import { DATA_LIMITS } from "../../shared/data-surface.ts";
import { tableIdentifierParts } from "./identifiers.ts";
import { singleStatement } from "./sql-statements.ts";
import type { DataSheetStore } from "./sheet.ts";
import type { BotDatabase, DataConnection } from "./types.ts";

const tails = new Map<BotDatabase, Promise<void>>();

export function withReplaceLock<T>(database: BotDatabase, work: () => Promise<T>): Promise<T> {
  const previous = tails.get(database) ?? Promise.resolve();
  const run = previous.then(() => work(), () => work());
  const done = run.then(() => undefined, () => undefined);
  tails.set(database, done);
  done.then(() => { if (tails.get(database) === done) tails.delete(database); }, () => undefined);
  return run;
}

interface ReplaceContext {
  database: BotDatabase;
  sheet: DataSheetStore;
  connection: DataConnection;
  signal: AbortSignal;
}

export async function commitReplacingCreate(ctx: ReplaceContext, sql: string, target: string, run: () => Promise<unknown>): Promise<void> {
  const name = await replacedLocalTable(ctx, sql, target);
  const write = async () => {
    await run();
    if (name) forgetReplacedImport(ctx, name);
  };
  if (name) await withReplaceLock(ctx.database, write);
  else await write();
}

function forgetReplacedImport(ctx: ReplaceContext, name: string): void {
  const names = ctx.sheet.sheet().sources.filter((source) => source.name.toLowerCase() === name).map((source) => source.name);
  for (const sourceName of names) ctx.sheet.removeSource(sourceName);
}

async function replacedLocalTable(ctx: ReplaceContext, sql: string, target: string): Promise<string | null> {
  const { tokens } = singleStatement(sql);
  const head = tokens.slice(tokens.findIndex((token) => token.text === "CREATE"));
  if (head[0]?.text !== "CREATE" || head[1]?.text !== "OR" || head[2]?.text !== "REPLACE") return null;
  if (head[3]?.text === "TEMP" || head[3]?.text === "TEMPORARY") return null;
  return localMainTable(ctx, target);
}

// DuckDB 1.5 reads catalog.table as main.table when the qualifier is this file's database name.
async function localMainTable(ctx: ReplaceContext, target: string): Promise<string | null> {
  const parts = tableIdentifierParts(target);
  if (!parts || parts.length > 3) return null;
  const table = parts[parts.length - 1]!.toLowerCase();
  const qualifier = parts.slice(0, -1).map((part) => part.toLowerCase());
  if (!qualifier.length || (qualifier.length === 1 && qualifier[0] === "main")) return table;
  const options = { connection: ctx.connection, signal: ctx.signal, timeoutMs: DATA_LIMITS.sqlTimeoutMs };
  if (qualifier[0] !== String((await ctx.database.run("SELECT current_database()", options)).rows[0]?.[0] ?? "").toLowerCase()) return null;
  return qualifier.length === 1 || qualifier[1] === "main" ? table : null;
}
