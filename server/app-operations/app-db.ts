// The server's side of one app's database process (app-db.worker.ts): requests over IPC, each with its own deadline. A
// statement past its deadline cannot be interrupted in node:sqlite, so the process is killed, every request in flight
// fails, and the next request starts a fresh process (SQLite rolls the unfinished transaction back when it reopens).
import { fork, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { AppMigration } from "./manifest.ts";
import { AppOperationError } from "./errors.ts";

export interface AppDbLimits {
  rows: number;
  bytes: number;
  statementMs: number;
}

export interface AppDbOptions {
  file: string;
  migrations: AppMigration[];
  limits: AppDbLimits;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  truncated: boolean;
}

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

function workerEntry(): string {
  const source = fileURLToPath(new URL("./app-db.worker.ts", import.meta.url));
  return existsSync(source) ? source : fileURLToPath(new URL("./app-db.worker.js", import.meta.url));
}

export class AppDatabase {
  private child: ChildProcess | null = null;
  private opening: Promise<void> | null = null;
  private readonly pending = new Map<number, Pending>();
  private seq = 0;
  /** Starts of the database process, and kills for a statement past its time: for tests and the report. */
  readonly stats = { starts: 0, killed: 0, applied: [] as number[] };
  private readonly options: AppDbOptions;

  constructor(options: AppDbOptions) { this.options = options; }

  get pid(): number | undefined { return this.child?.pid; }

  private start(): Promise<void> {
    if (this.opening) return this.opening;
    mkdirSync(dirname(this.options.file), { recursive: true, mode: 0o700 });
    const child = fork(workerEntry(), [], {
      execArgv: [],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: { ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}), PATH: "" },
      serialization: "json",
    });
    this.child = child;
    this.stats.starts += 1;
    child.stderr?.resume();
    child.on("message", (message: { id: number; ok: boolean; value?: unknown; error?: string; code?: string }) => {
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.ok) waiting.resolve(message.value);
      else waiting.reject(new AppOperationError(message.code ?? "sql_error", message.error ?? "The statement failed."));
    });
    child.on("exit", () => {
      if (this.child !== child) return;
      this.child = null;
      this.opening = null;
      this.failAll(new AppOperationError("database_stopped", "The app's database stopped. Any change in progress was rolled back."));
    });
    this.opening = this.send<{ applied: number[] }>({ op: "open", file: this.options.file, migrations: this.options.migrations, limits: { rows: this.options.limits.rows, bytes: this.options.limits.bytes } }, 30_000, true)
      .then((opened) => { this.stats.applied.push(...opened.applied); })
      .catch((error) => { this.kill(); throw error; });
    return this.opening;
  }

  private failAll(error: Error) {
    for (const [id, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      this.pending.delete(id);
      waiting.reject(error);
    }
  }

  private send<T>(message: Record<string, unknown>, timeoutMs: number, opening = false): Promise<T> {
    const child = this.child;
    if (!child?.connected) return Promise.reject(new AppOperationError("database_stopped", "The app's database is not running."));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.stats.killed += 1;
        reject(new AppOperationError("statement_timeout", opening
          ? "The app's database took too long to open."
          : `A statement ran past ${timeoutMs / 1000} seconds and was stopped; any change in progress was rolled back.`));
        this.kill();
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      child.send({ id, ...message });
    });
  }

  async request<T>(message: Record<string, unknown>): Promise<T> {
    await this.start();
    return this.send<T>(message, this.options.limits.statementMs);
  }

  query(sql: string, params: unknown, mode: "read" | "write"): Promise<QueryResult> {
    return this.request({ op: "query", sql, params, mode });
  }

  exec(sql: string, params: unknown): Promise<{ changes: number; lastInsertRowid: unknown }> {
    return this.request({ op: "exec", sql, params });
  }

  private changeStartedIn = 0;

  async begin(): Promise<void> {
    await this.request({ op: "begin" });
    this.changeStartedIn = this.stats.starts;
  }

  /** Commits the change in progress; refuses when the process it began in was stopped, which has rolled it back. */
  async commit(): Promise<void> {
    if (this.changeStartedIn !== this.stats.starts || !this.child?.connected) {
      throw new AppOperationError("database_stopped", "The app's database stopped during this change, so it was rolled back.");
    }
    await this.request({ op: "commit" });
  }

  /** Rolls back the change in progress; a database process that is gone has already lost it. */
  async rollback(): Promise<void> {
    if (!this.child?.connected) return;
    await this.send({ op: "rollback" }, this.options.limits.statementMs).catch(() => {});
  }

  /** Settles when the last killed database process has exited. */
  lastExit: Promise<void> = Promise.resolve();

  kill() {
    const child = this.child;
    if (!child) return;
    this.lastExit = new Promise((resolve) => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once("exit", () => resolve()); });
    this.child = null;
    this.opening = null;
    child.kill("SIGKILL");
    this.failAll(new AppOperationError("database_stopped", "The app's database was stopped. Any change in progress was rolled back."));
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try { await this.send({ op: "close" }, 5_000); } catch { /* killed below */ }
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    await exited;
    clearTimeout(timer);
  }
}
