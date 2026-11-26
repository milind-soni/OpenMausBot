// mausbot.data and mausbot.state for a bot's own page, on its rpc route once the route has checked the bot, the
// conversation and the row. Each answers only for what the page's current version declared (show_html `uses`).
import { APP_LIMITS, type AppUse } from "../../shared/app.ts";
import { pageUseRefusal, RPC_HOST_REFUSED, RPC_INVALID_PARAMS, type PageRpcMethod } from "../../shared/app-frame/bridge.ts";
import type { ChatApps } from "../chat-apps.ts";
import { boundRows } from "../data/tools.ts";
import { DataFailure, type DataEngine, type RunResult } from "../data/types.ts";

export interface PageRpcDeps {
  apps: Pick<ChatApps, "declaredUses" | "states" | "paused">;
  data?: Pick<DataEngine, "unavailable" | "forBot">;
  /** True when the person switched this bot's Data tools off. */
  dataOff?(botId: string): boolean;
}

export interface PageRpcAnswer {
  status: number;
  body: Record<string, unknown>;
}

const PAUSED = "This page waits while this computer is backed up. Try again in a moment.";
const answer = (body: Record<string, unknown>): PageRpcAnswer => ({ status: 200, body });
const refuse = (status: number, message: string, code = RPC_HOST_REFUSED): PageRpcAnswer => ({ status, body: { error: { code, message } } });

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const INTEGER_TYPE = /^(?:U?TINYINT|U?SMALLINT|U?INTEGER|U?BIGINT|U?HUGEINT)$/;

/** Rows as objects by column name, with whole numbers and decimals as JS numbers where they fit. A repeated column name
 * gets `_2`, `_3`… so no cell is lost. */
export function pageRows(result: Pick<RunResult, "columns" | "rows">): { columns: Array<{ name: string; type: string }>; rows: Array<Record<string, unknown>> } {
  const seen = new Map<string, number>();
  const columns = result.columns.map((column) => {
    const count = (seen.get(column.name) ?? 0) + 1;
    seen.set(column.name, count);
    return { name: count === 1 ? column.name : `${column.name}_${count}`, type: column.type };
  });
  const numeric = columns.map((column) => INTEGER_TYPE.test(column.type) ? "integer" : column.type.startsWith("DECIMAL") ? "decimal" : null);
  const rows = result.rows.map((row) => {
    const out: Record<string, unknown> = {};
    columns.forEach((column, index) => {
      const cell = row[index] ?? null;
      const kind = numeric[index];
      if (typeof cell === "string" && kind) {
        const value = Number(cell);
        out[column.name] = Number.isFinite(value) && (kind === "decimal" || Number.isSafeInteger(value)) ? value : cell;
      } else out[column.name] = cell;
    });
    return out;
  });
  return { columns, rows };
}

async function query(deps: PageRpcDeps, botId: string, params: Record<string, unknown>): Promise<PageRpcAnswer> {
  if (!deps.data) return refuse(503, "This page cannot read data on this computer.");
  if (deps.apps.paused()) return refuse(503, PAUSED);
  if (deps.dataOff?.(botId)) return refuse(409, "Data is switched off for this bot, so its pages cannot read it.");
  const unavailable = deps.data.unavailable();
  if (unavailable !== null) return refuse(503, unavailable);
  const sql = params.sql;
  if (typeof sql !== "string" || !sql.trim() || sql.length > APP_LIMITS.pageQuerySqlChars) {
    return refuse(400, `mausbot.data.query needs one SELECT of at most ${APP_LIMITS.pageQuerySqlChars} characters.`, RPC_INVALID_PARAMS);
  }
  const given = params.params;
  if (given !== undefined && !Array.isArray(given) && !isRecord(given)) {
    return refuse(400, "mausbot.data.query params: a list for ? or $1, or an object for $name.", RPC_INVALID_PARAMS);
  }
  try {
    const database = await deps.data.forBot(botId);
    const result = await database.pageQuery(sql, given, { maxRows: APP_LIMITS.pageQueryRows, timeoutMs: APP_LIMITS.pageQueryMs });
    const bounded = boundRows(result.rows, APP_LIMITS.pageQueryRows, APP_LIMITS.pageQueryBytes);
    const shaped = pageRows({ columns: result.columns, rows: bounded.rows });
    let rows = shaped.rows;
    let truncated = result.truncated || bounded.truncated;
    // Rows as objects repeat their column names: the cap holds for what is sent.
    while (rows.length && Buffer.byteLength(JSON.stringify(rows)) > APP_LIMITS.pageQueryBytes) {
      rows = rows.slice(0, rows.length - Math.max(1, Math.ceil(rows.length / 10)));
      truncated = true;
    }
    return answer({ columns: shaped.columns, rows, truncated });
  } catch (error) {
    if (!(error instanceof DataFailure)) throw error;
    const { code, message, hint } = error.error;
    const status = code === "write_refused" ? 409 : code === "timeout" || code === "engine_unavailable" ? 503 : 422;
    const text = code === "timeout" ? `The query ran past ${APP_LIMITS.pageQueryMs / 1000} seconds. Aggregate or filter first.` : message;
    return refuse(status, hint && code === "write_refused" ? `${text} ${hint}` : text);
  }
}

export async function pageRpc(deps: PageRpcDeps, call: { botId: string; threadId: string; messageId: string; method: PageRpcMethod; params: Record<string, unknown> }): Promise<PageRpcAnswer> {
  const use: AppUse = call.method === "mausbot/data/query" ? "data" : "state";
  if (!deps.apps.declaredUses(call.threadId, call.messageId).includes(use)) return refuse(409, pageUseRefusal(use, false));
  if (call.method === "mausbot/data/query") return query(deps, call.botId, call.params);
  const { states } = deps.apps;
  const key = call.params.key;
  const keyed = typeof key === "string" && key.length > 0 && key.length <= APP_LIMITS.pageStateKeyChars;
  if (call.method !== "mausbot/state/keys" && !keyed) {
    return refuse(400, `A state key is text of 1 to ${APP_LIMITS.pageStateKeyChars} characters.`, RPC_INVALID_PARAMS);
  }
  if (call.method === "mausbot/state/keys") {
    const keys = states.keys(call.threadId, call.messageId);
    return keys.ok ? answer({ keys: keys.value }) : refuse(keys.status, keys.error);
  }
  if (call.method === "mausbot/state/get") {
    const got = states.get(call.threadId, call.messageId, key as string);
    return got.ok ? answer(got.value === undefined ? {} : { value: got.value }) : refuse(got.status, got.error);
  }
  if (deps.apps.paused()) return refuse(503, PAUSED);
  const set = states.set(call.threadId, call.messageId, key as string, call.params.value);
  return set.ok ? answer({}) : refuse(set.status, set.error, set.status === 400 ? RPC_INVALID_PARAMS : RPC_HOST_REFUSED);
}
