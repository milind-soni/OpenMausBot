// A BotDatabase for tests: answers the SQL the Data tools build without
// DuckDB, records every call, and lets a test script the next answer or
// failure. Test-only; never imported by the server.
import { writeFileSync } from "node:fs";

import type { DataColumn, DataColumnStats, DataHistogram, DataPage } from "../../shared/data-surface.ts";
import { DataFailure, type BotDatabase, type DataConnection, type DescribeResult, type MaterialiseResult, type RunOptions, type RunResult } from "../data/types.ts";

type Rows = RunResult["rows"];
export interface FakeTable { columns: DataColumn[]; rows: Rows }
export interface RecordedCall { method: string; sql?: string; name?: string; target?: string; connection?: DataConnection; maxRows?: number }

const DEFAULT_COLUMNS: DataColumn[] = [{ name: "id", type: "INTEGER" }, { name: "name", type: "VARCHAR" }];
const DEFAULT_ROWS: Rows = [[1, "one"], [2, "two"], [3, "three"]];

export class FakeDataDatabase implements BotDatabase {
  readonly botId: string;
  readonly calls: RecordedCall[] = [];
  /** Source tables (outside omb_results). */
  readonly tables = new Map<string, FakeTable>();
  /** Result tables (omb_results). */
  readonly results = new Map<string, FakeTable>();
  readonly interrupted: DataConnection[] = [];
  /** What the next materialise/run produces; cleared after use. */
  next: Partial<FakeTable & { rowCount: number }> | null = null;
  /** Thrown by the next statement that runs; cleared after use. */
  failNext: unknown = null;
  /** A hook that may answer a statement itself (return undefined to fall through). */
  onRun?: (sql: string, options: RunOptions) => RunResult | undefined;
  /** Delays every statement, for cancellation tests. */
  delayMs = 0;

  constructor(botId = "bot-1") {
    this.botId = botId;
  }

  private async settle(options: { signal?: AbortSignal }): Promise<void> {
    if (this.delayMs) {
      await new Promise<void>((done, reject) => {
        const timer = setTimeout(done, this.delayMs);
        options.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("aborted", "AbortError")); }, { once: true });
      });
    }
    options.signal?.throwIfAborted();
    if (this.failNext) { const error = this.failNext; this.failNext = null; throw error; }
  }

  private take(): FakeTable & { rowCount: number } {
    const next = this.next;
    this.next = null;
    const rows = next?.rows ?? DEFAULT_ROWS;
    return { columns: next?.columns ?? DEFAULT_COLUMNS, rows, rowCount: next?.rowCount ?? rows.length };
  }

  private relation(sql: string): FakeTable | undefined {
    const result = /FROM omb_results\."([^"]+)"/.exec(sql) ?? /FROM omb_results\.(\w+)/.exec(sql);
    if (result) return this.results.get(result[1]!);
    const table = /FROM "([^"]+)"/.exec(sql);
    return table ? this.tables.get(table[1]!) : undefined;
  }

  async run(sql: string, options: RunOptions): Promise<RunResult> {
    this.calls.push({ method: "run", sql, connection: options.connection, maxRows: options.maxRows });
    await this.settle(options);
    const scripted = this.onRun?.(sql, options);
    if (scripted) return scripted;
    const done = (columns: DataColumn[], rows: Rows, rowCount = rows.length): RunResult => {
      const kept = options.maxRows === undefined ? rows : rows.slice(0, options.maxRows);
      return { columns, rows: kept, rowCount, truncated: kept.length < rows.length, elapsedMs: 1 };
    };
    if (/^COPY /i.test(sql)) {
      const path = /TO '((?:[^']|'')*)'/.exec(sql)?.[1]?.replace(/''/g, "'");
      if (path) writeFileSync(path, "id,name\n1,one\n2,two\n");
      return done([{ name: "Count", type: "BIGINT" }], [[2]]);
    }
    if (/^(CREATE|ATTACH|DETACH)\b/i.test(sql)) {
      const created = /^CREATE (?:OR REPLACE )?TABLE "([^"]+)"/i.exec(sql);
      if (created) this.tables.set(created[1]!, this.take());
      return done([], []);
    }
    // A `LIMIT 0` probe asks for columns only and never consumes the scripted answer.
    if (/LIMIT 0$/i.test(sql)) return done(this.next?.columns ?? DEFAULT_COLUMNS, [], 0);
    if (/^SELECT count\(\*\) FROM/i.test(sql)) {
      const relation = this.relation(sql);
      return done([{ name: "count_star()", type: "BIGINT" }], [[relation ? relation.rows.length : 1234]]);
    }
    if (/duckdb_tables\(\)/.test(sql)) {
      return done([{ name: "schema_name", type: "VARCHAR" }, { name: "table_name", type: "VARCHAR" }], [["public", "orders"], ["public", "people"]]);
    }
    const relation = this.relation(sql);
    if (relation) {
      const limit = /LIMIT (\d+)/i.exec(sql);
      const rows = limit ? relation.rows.slice(0, Number(limit[1])) : relation.rows;
      return done(relation.columns, rows, rows.length);
    }
    const next = this.take();
    return done(next.columns, next.rows, next.rowCount);
  }

  async materialise(sql: string, name: string, options: RunOptions): Promise<MaterialiseResult> {
    this.calls.push({ method: "materialise", sql, name, connection: options.connection });
    await this.settle(options);
    const next = this.take();
    this.results.set(name, { columns: next.columns, rows: next.rows });
    return { table: `omb_results.${name}`, columns: next.columns, rowCount: next.rowCount, elapsedMs: 2 };
  }

  async dropResult(name: string, connection?: DataConnection): Promise<void> {
    this.calls.push({ method: "dropResult", name, ...(connection ? { connection } : {}) });
    this.results.delete(name);
  }

  async page(target: string, options: { offset: number; limit: number; signal?: AbortSignal }): Promise<DataPage> {
    this.calls.push({ method: "page", target });
    await this.settle(options);
    const table = this.results.get(target.replace(/^omb_results\./, "").replace(/"/g, "")) ?? this.tables.get(target.replace(/"/g, ""));
    if (!table) throw new DataFailure({ code: "table_not_found", message: `Table ${target} does not exist` });
    return { columns: table.columns, rows: table.rows.slice(options.offset, options.offset + options.limit), rowCount: table.rows.length, offset: options.offset };
  }

  async describe(target: string, options: RunOptions): Promise<DescribeResult> {
    this.calls.push({ method: "describe", target, connection: options.connection });
    await this.settle(options);
    const next = this.next ? this.take() : null;
    const table = this.tables.get(target.replace(/"/g, ""));
    const columns = next?.columns ?? table?.columns ?? DEFAULT_COLUMNS;
    return {
      rowCount: next?.rowCount ?? table?.rows.length ?? 3,
      columns: columns.map((column) => ({ ...column, nullPct: 0, approxUnique: 3, min: "1", max: "3", sample: column.sample ?? ["1", "2", "3"] })),
    };
  }

  async stats(table: string, options: { signal?: AbortSignal } = {}): Promise<DataColumnStats> {
    this.calls.push({ method: "stats", target: table });
    await this.settle(options);
    const found = this.tables.get(table.replace(/"/g, ""));
    if (!found) throw new DataFailure({ code: "table_not_found", message: `Table ${table} does not exist` });
    return { table, rowCount: found.rows.length, columns: found.columns };
  }

  async histogram(table: string, column: string, options: { bins?: number; signal?: AbortSignal } = {}): Promise<DataHistogram> {
    this.calls.push({ method: "histogram", target: `${table}.${column}` });
    await this.settle(options);
    return { table, column, bins: [{ label: "1", count: 1 }, { label: "2", count: 2 }] };
  }

  async listTables(): Promise<Array<{ name: string; rowCount: number; columns: DataColumn[] }>> {
    this.calls.push({ method: "listTables" });
    return [...this.tables.entries()].map(([name, table]) => ({ name, rowCount: table.rows.length, columns: table.columns }));
  }

  interrupt(connection: DataConnection): void {
    this.interrupted.push(connection);
  }

  async resolveTable(name: string): Promise<string> {
    this.calls.push({ method: "resolveTable", target: name });
    const bare = name.replace(/"/g, "");
    const match = [...this.tables.keys()].find((table) => table.toLowerCase() === bare.toLowerCase());
    if (!match) throw new DataFailure({ code: "table_not_found", message: `Table with name ${bare} does not exist!`, candidates: [...this.tables.keys()] });
    return `"${match}"`;
  }

  async close(): Promise<void> {}
}
