// App operations: a saved app's own server-side functions, run without a model turn in a workerd process of the app's own
// (started on first call, stopped when idle, restarted after a crash, reloaded when its server side changes), each with
// the app's own SQLite file in a database process of its own.
//
// Security: one workerd process per app, so an app's isolate never shares a process with another app's, a runaway app is
// killed without touching the others, and its memory is its own. Limits our server enforces, since workerd does not:
// total operation time (the process is killed past it), concurrent operations per app, input and result size.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DataEngine } from "../data/types.ts";
import { pageDataQuery } from "../routes/bot-page-rpc.ts";
import { AppDatabase } from "./app-db.ts";
import { NO_CONNECTORS, type ConnectorGate } from "./connectors.ts";
import { AppOperationError } from "./errors.ts";
import { HostService, type HostInvocation } from "./host-service.ts";
import { appStamp, AppManifestError, loadApp, type LoadedApp, type OperationKind } from "./manifest.ts";
import { WORKERD_COMPATIBILITY_DATE } from "./runtime.ts";
import { WRAPPER_MODULE, workerdConfig } from "./workerd-config.ts";

export interface AppOperationLimits {
  sqlChars: number;
  rows: number;
  bytes: number;
  statementMs: number;
  operationMs: number;
  concurrent: number;
  inputBytes: number;
  resultBytes: number;
  heapMb: number;
  /** The runtime process's resident memory past which it is killed: memory outside the V8 heap (ArrayBuffers) is not under heapMb. */
  rssMb: number;
  logLines: number;
}

export const APP_OPERATION_LIMITS: AppOperationLimits = {
  sqlChars: 20_000,
  rows: 5_000,
  bytes: 1_000_000,
  statementMs: 5_000,
  operationMs: 10_000,
  concurrent: 4,
  inputBytes: 64 * 1024,
  resultBytes: 1_000_000,
  heapMb: 128,
  rssMb: 512,
  logLines: 200,
};

export interface AppOperationsOptions {
  dataDir: string;
  /** The workerd binary: ensureRuntime() in the product. */
  binary(): Promise<string>;
  data?: Pick<DataEngine, "unavailable" | "forBot">;
  dataOff?(botId: string): boolean;
  connectors?: ConnectorGate;
  limits?: Partial<AppOperationLimits>;
  idleMs?: number;
}

/** Who is calling: a page passes whether the person clicked in it (the bridge's own engagement check). */
export interface AppCaller {
  botId: string;
  via: "page" | "server";
  engaged?: boolean;
}

export interface RunOperation {
  appDir: string;
  name: string;
  input: unknown;
  caller: AppCaller;
}

export type StopReason = "idle" | "reload" | "crash" | "timeout" | "memory" | "shutdown";

interface Running {
  process: ChildProcess;
  folder: string;
  socket: string;
  exited: Promise<void>;
  stopping: StopReason | null;
}

interface AppState {
  app: LoadedApp;
  stamp: string;
  db: AppDatabase;
  secret: string;
  running: Running | null;
  starting: Promise<Running> | null;
  active: number;
  writeLock: Promise<void>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  logs: string[];
  starts: number;
  crashes: number;
}

function socketPath(folder: string): { listen: string; path: string } {
  if (process.platform === "win32") throw new AppOperationError("runtime_unavailable", "App operations on Windows need the loopback listener, which this prototype does not start yet.");
  const path = join(folder, "w.sock");
  return { listen: `unix:${path}`, path };
}

function post(socket: string, body: string, timeoutMs: number): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ socketPath: socket, path: "/", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", reject);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new AppOperationError("timeout", "timeout")));
    request.on("error", reject);
    request.end(body);
  });
}

/** Resident memory of `pid` in MB: /proc on Linux, ps on macOS; null where neither answers (Windows needs its own). */
function residentMb(pid: number): Promise<number | null> {
  if (process.platform === "linux") {
    return import("node:fs/promises").then((fs) => fs.readFile(`/proc/${pid}/statm`, "utf8")).then((text) => Number(text.split(" ")[1]) * 4096 / 1048576, () => null);
  }
  if (process.platform !== "darwin") return Promise.resolve(null);
  return new Promise((resolve) => execFile("/bin/ps", ["-o", "rss=", "-p", String(pid)], (error, stdout) => resolve(error ? null : Number(stdout.trim()) / 1024)));
}

export class AppOperations extends EventEmitter {
  private readonly apps = new Map<string, AppState>();
  private readonly host = new HostService();
  private readonly limits: AppOperationLimits;
  private readonly options: AppOperationsOptions;
  private closed = false;
  /** Every runtime process started and not yet exited, whatever the bookkeeping says: stopAll ends them all. */
  private readonly children = new Set<ChildProcess>();

  constructor(options: AppOperationsOptions) {
    super();
    this.options = options;
    this.limits = { ...APP_OPERATION_LIMITS, ...options.limits };
  }

  /** The host service, for tests that knock on it directly. */
  get hostService(): HostService { return this.host; }

  state(appDir: string): { pid?: number; dbPid?: number; starts: number; crashes: number; logs: string[]; secret: string; id: string; migrations: number[] } | null {
    for (const state of this.apps.values()) {
      if (state.app.dir === appDir || state.app.dir.endsWith(appDir)) {
        return { pid: state.running?.process.pid, dbPid: state.db.pid, starts: state.starts, crashes: state.crashes, logs: state.logs, secret: state.secret, id: state.app.id, migrations: state.db.stats.applied };
      }
    }
    return null;
  }

  private appState(appDir: string): AppState {
    let loaded: LoadedApp;
    try { loaded = loadApp(appDir); } catch (error) {
      throw new AppOperationError("app_invalid", error instanceof AppManifestError ? error.message : `The app could not be read: ${(error as Error).message}`);
    }
    const existing = this.apps.get(loaded.id);
    if (existing && existing.app.signature === loaded.signature) {
      existing.stamp = appStamp(loaded.dir);
      return existing;
    }
    const file = join(this.options.dataDir, "app-operations", loaded.id, "app.db");
    const migrationsChanged = !existing || existing.app.migrations.map((m) => m.sql).join("\0") !== loaded.migrations.map((m) => m.sql).join("\0");
    const state: AppState = existing ?? {
      app: loaded, stamp: "", db: new AppDatabase({ file, migrations: loaded.migrations, limits: this.dbLimits() }),
      secret: randomBytes(32).toString("hex"), running: null, starting: null, active: 0, writeLock: Promise.resolve(),
      idleTimer: null, logs: [], starts: 0, crashes: 0,
    };
    if (existing) {
      void this.stopProcess(existing, "reload");
      if (migrationsChanged) {
        void existing.db.close();
        state.db = new AppDatabase({ file, migrations: loaded.migrations, limits: this.dbLimits() });
      }
    }
    state.app = loaded;
    state.stamp = appStamp(loaded.dir);
    this.apps.set(loaded.id, state);
    return state;
  }

  private dbLimits() {
    return { rows: this.limits.rows, bytes: this.limits.bytes, statementMs: this.limits.statementMs };
  }

  /** The state for `appDir`, re-read only when the folder's stamp moved. */
  private current(appDir: string): AppState {
    for (const state of this.apps.values()) {
      if (state.app.dir === appDir && state.stamp === appStamp(appDir)) return state;
    }
    return this.appState(appDir);
  }

  async run({ appDir, name, input, caller }: RunOperation): Promise<unknown> {
    if (this.closed) throw new AppOperationError("runtime_stopped", "App operations have stopped.");
    const state = this.current(appDir);
    const declared = Object.prototype.hasOwnProperty.call(state.app.manifest.operations, name) ? state.app.manifest.operations[name] : undefined;
    if (!declared) throw new AppOperationError("unknown_operation", `${state.app.manifest.name} has no operation ${name}.`);
    if (declared.kind === "change" && caller.via === "page" && !caller.engaged) {
      throw new AppOperationError("needs_click", "Changes run only after the person clicks in the app.");
    }
    let payload: string;
    try { payload = JSON.stringify(input ?? null); } catch { throw new AppOperationError("invalid_input", "An operation's input must be JSON."); }
    if (Buffer.byteLength(payload) > this.limits.inputBytes) throw new AppOperationError("too_large", `An operation's input is at most ${this.limits.inputBytes} bytes.`);
    if (state.active >= this.limits.concurrent) throw new AppOperationError("busy", `At most ${this.limits.concurrent} operations of an app run at once. Try again in a moment.`);
    state.active += 1;
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = null;
    const deadline = Date.now() + this.limits.operationMs;
    let release = () => {};
    try {
      if (declared.kind === "change") {
        const previous = state.writeLock;
        state.writeLock = new Promise((resolve) => { release = resolve; });
        await Promise.race([previous, new Promise((_, reject) => setTimeout(() => reject(new AppOperationError("busy", "Another change of this app is still running.")), Math.max(0, deadline - Date.now())).unref())]);
      }
      return await this.invoke(state, name, declared.kind, payload, caller, deadline);
    } finally {
      release();
      state.active -= 1;
      if (state.active === 0 && !this.closed) this.armIdle(state);
    }
  }

  private armIdle(state: AppState) {
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      state.idleTimer = null;
      if (state.active === 0) {
        void this.stopProcess(state, "idle");
        void state.db.close();
      }
    }, this.options.idleMs ?? 60_000);
    state.idleTimer.unref();
  }

  private async invoke(state: AppState, name: string, kind: OperationKind, payload: string, caller: AppCaller, deadline: number): Promise<unknown> {
    const running = await this.ensureProcess(state);
    const token = randomBytes(24).toString("hex");
    const db = state.db;
    if (kind === "change") await db.begin();
    let finished = false;
    const invocation: HostInvocation = { handle: (path, body) => {
      if (finished) throw new AppOperationError("forbidden", "This operation has already finished.");
      return this.hostCall(state, kind, caller, path, body);
    } };
    this.host.open(state.app.id, token, invocation);
    const body = `{"name":${JSON.stringify(name)},"invocation":${JSON.stringify(token)},"input":${payload}}`;
    let answer: { ok: boolean; result?: unknown; code?: string; error?: string };
    const watch = this.watchMemory(state, running);
    try {
      const response = await post(running.socket, body, Math.max(1, deadline - Date.now()));
      if (response.text.length > this.limits.resultBytes + 64) throw new AppOperationError("too_large", `An operation's result is at most ${this.limits.resultBytes} bytes.`);
      answer = JSON.parse(response.text);
    } catch (error) {
      clearInterval(watch);
      finished = true;
      this.host.close(state.app.id, token);
      if (kind === "change") await db.rollback();
      if (error instanceof AppOperationError && error.code === "timeout") {
        await this.stopProcess(state, "timeout");
        throw new AppOperationError("timeout", `${name} ran past ${this.limits.operationMs / 1000} seconds and was stopped.${kind === "change" ? " Its changes were rolled back." : ""}`);
      }
      if (error instanceof AppOperationError) throw error;
      await Promise.race([running.exited, new Promise((resolve) => setTimeout(resolve, 1_000).unref())]);
      if (running.stopping === "memory") throw new AppOperationError("memory", `${name} used more than ${this.limits.rssMb} MB and was stopped.${kind === "change" ? " Its changes were rolled back." : ""}`);
      throw new AppOperationError("runtime_stopped", `The app's runtime stopped while ${name} ran.${kind === "change" ? " Its changes were rolled back." : ""}`);
    }
    clearInterval(watch);
    finished = true;
    this.host.close(state.app.id, token);
    if (!answer.ok) {
      if (kind === "change") await db.rollback();
      throw new AppOperationError(answer.code ?? "operation_failed", answer.error ?? `${name} failed.`);
    }
    if (kind === "change") await db.commit();
    return answer.result ?? null;
  }

  /** Samples the runtime's resident memory while an operation runs, and kills it past rssMb. */
  private watchMemory(state: AppState, running: Running): ReturnType<typeof setInterval> {
    const pid = running.process.pid;
    const timer = setInterval(() => {
      if (!pid || running.stopping) return;
      void residentMb(pid).then((mb) => {
        if (mb !== null && mb > this.limits.rssMb && state.running === running) void this.stopProcess(state, "memory");
      });
    }, 100);
    timer.unref();
    return timer;
  }

  private async hostCall(state: AppState, kind: OperationKind, caller: AppCaller, path: string, body: Record<string, unknown>): Promise<unknown> {
    const sqlOf = () => {
      if (typeof body.sql !== "string" || !body.sql.trim() || body.sql.length > this.limits.sqlChars) {
        throw new AppOperationError("invalid_input", `SQL is text of at most ${this.limits.sqlChars} characters.`);
      }
      if (body.params !== undefined && body.params !== null && typeof body.params !== "object") {
        throw new AppOperationError("invalid_params", "SQL params are a list for ? or an object for :name.");
      }
      return body.sql;
    };
    switch (path) {
      case "/db/query":
        return state.db.query(sqlOf(), body.params ?? undefined, kind === "change" ? "write" : "read");
      case "/db/exec":
        if (kind !== "change") throw new AppOperationError("read_only", "ctx.db.exec runs only in a change operation; this one is a read.");
        return state.db.exec(sqlOf(), body.params ?? undefined);
      case "/data/query": {
        if (!state.app.manifest.uses.includes("data")) throw new AppOperationError("not_declared", 'This app did not declare "data": add uses: ["data"] to app.json to read its bot\'s data.');
        const answer = await pageDataQuery({ apps: { paused: () => false, declaredUses: () => ["data"], states: undefined as never } as never, data: this.options.data, dataOff: this.options.dataOff }, caller.botId, { sql: sqlOf(), params: body.params ?? undefined });
        const error = (answer.body as { error?: { message?: string } }).error;
        if (error) throw new AppOperationError(answer.status === 409 ? "read_only" : "sql_error", error.message ?? "The query failed.");
        return answer.body;
      }
      case "/connectors/call":
        if (!state.app.manifest.uses.includes("connectors")) throw new AppOperationError("not_declared", 'This app did not declare "connectors".');
        return (this.options.connectors ?? NO_CONNECTORS).call(state.app.manifest.connectors, String(body.connector ?? ""), String(body.tool ?? ""), body.args);
      case "/log": {
        const line = String(body.text ?? "").slice(0, 2_000);
        state.logs.push(line);
        if (state.logs.length > this.limits.logLines) state.logs.splice(0, state.logs.length - this.limits.logLines);
        return null;
      }
      default:
        throw new AppOperationError("forbidden", "The host service has no such call.");
    }
  }

  private ensureProcess(state: AppState): Promise<Running> {
    if (state.running) return Promise.resolve(state.running);
    if (state.starting) return state.starting;
    state.starting = this.startProcess(state).finally(() => { state.starting = null; });
    return state.starting;
  }

  private async startProcess(state: AppState): Promise<Running> {
    const signature = state.app.signature;
    const [binary, hostAddress] = await Promise.all([this.options.binary(), this.host.start()]);
    if (this.closed) throw new AppOperationError("runtime_stopped", "App operations have stopped.");
    this.host.register(state.app.id, state.secret);
    const folder = mkdtempSync(join(tmpdir(), "omb-ao-"));
    chmodSync(folder, 0o700);
    const { listen, path: socket } = socketPath(folder);
    writeFileSync(join(folder, "main.js"), WRAPPER_MODULE, { mode: 0o600 });
    copyFileSync(state.app.operationsFile, join(folder, "operations.js"));
    writeFileSync(join(folder, "config.capnp"), workerdConfig({ listen, host: hostAddress, secret: state.secret, compatibilityDate: WORKERD_COMPATIBILITY_DATE, heapMb: this.limits.heapMb }), { mode: 0o600 });
    const child = spawn(binary, ["serve", "config.capnp", "--control-fd=3"], {
      cwd: folder,
      env: {},
      stdio: ["ignore", "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    state.starts += 1;
    this.children.add(child);
    child.once("exit", () => this.children.delete(child));
    const output: string[] = [];
    const keep = (chunk: Buffer) => { output.push(chunk.toString("utf8")); if (output.length > 50) output.shift(); };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const running: Running = { process: child, folder, socket, exited, stopping: null };
    this.recordPid(state.app.id, child.pid, folder);
    child.once("exit", (code, signal) => {
      rmSync(folder, { recursive: true, force: true });
      this.forgetPid(state.app.id);
      if (state.running === running) state.running = null;
      if (!running.stopping) {
        state.crashes += 1;
        state.logs.push(`runtime exited (${signal ?? code}): ${output.join("").slice(-500)}`);
      }
      this.emit("stopped", { appId: state.app.id, reason: running.stopping ?? "crash", pid: child.pid });
    });
    const control = child.stdio[3] as NodeJS.ReadableStream | null;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new AppOperationError("runtime_unavailable", `The app runtime did not start: ${output.join("").slice(-300)}`)); }, 10_000);
      let buffered = "";
      control?.on("data", (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        if (buffered.includes('"event":"listen"')) { clearTimeout(timer); resolve(); }
      });
      child.once("exit", () => { clearTimeout(timer); reject(new AppOperationError("runtime_unavailable", `The app runtime stopped while starting: ${output.join("").slice(-300)}`)); });
    });
    rmSync(join(folder, "config.capnp"), { force: true });
    if (this.closed || this.apps.get(state.app.id) !== state || state.app.signature !== signature) {
      running.stopping = this.closed ? "shutdown" : "reload";
      child.kill("SIGKILL");
      await exited;
      throw new AppOperationError("runtime_stopped", "The app changed or stopped while its runtime started. Try again.");
    }
    state.running = running;
    this.emit("started", { appId: state.app.id, pid: child.pid });
    return running;
  }

  private stopProcess(state: AppState, reason: StopReason): Promise<void> {
    const running = state.running;
    if (!running) return Promise.resolve();
    state.running = null;
    running.stopping = reason;
    running.process.kill(reason === "timeout" || reason === "memory" ? "SIGKILL" : "SIGTERM");
    const force = setTimeout(() => running.process.kill("SIGKILL"), 2_000);
    return running.exited.finally(() => clearTimeout(force));
  }

  private pidFile(appId: string) { return join(this.options.dataDir, "app-operations", "pids", `${appId}.json`); }

  private recordPid(appId: string, pid: number | undefined, folder: string) {
    if (!pid) return;
    mkdirSync(join(this.options.dataDir, "app-operations", "pids"), { recursive: true, mode: 0o700 });
    writeFileSync(this.pidFile(appId), JSON.stringify({ pid, folder }), { mode: 0o600 });
  }

  private forgetPid(appId: string) { rmSync(this.pidFile(appId), { force: true }); }

  /** Kills runtimes a previous server left behind (it was killed before it could stop them). Returns their pids. */
  static sweepOrphans(dataDir: string, isOurs: (pid: number) => boolean): number[] {
    const folder = join(dataDir, "app-operations", "pids");
    const killed: number[] = [];
    let names: string[] = [];
    try { names = readdirSync(folder); } catch { return killed; }
    for (const name of names) {
      try {
        const { pid, folder: runFolder } = JSON.parse(readFileSync(join(folder, name), "utf8")) as { pid: number; folder: string };
        if (isOurs(pid)) { process.kill(pid, "SIGKILL"); killed.push(pid); }
        rmSync(runFolder, { recursive: true, force: true });
      } catch { /* already gone */ }
      rmSync(join(folder, name), { force: true });
    }
    return killed;
  }

  /** Stops every runtime and database process; the server calls this when it stops. */
  async stopAll(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.apps.values()].map(async (state) => {
      if (state.idleTimer) clearTimeout(state.idleTimer);
      await Promise.all([this.stopProcess(state, "shutdown"), state.db.close()]);
    }));
    await Promise.all([...this.apps.values()].map((state) => state.starting?.catch(() => {})));
    const left = [...this.children];
    for (const child of left) child.kill("SIGKILL");
    await Promise.all(left.map((child) => child.exitCode !== null || child.signalCode !== null ? undefined : new Promise((resolve) => child.once("exit", resolve))));
    await this.host.stop();
  }

  /** For process exit handlers: kills every child at once, synchronously. */
  killAllNow() {
    for (const state of this.apps.values()) {
      state.running?.process.kill("SIGKILL");
      state.db.kill();
    }
  }
}
