// App operations end to end, through a real workerd: page call → route → workerd → host service → the app's SQLite → back,
// and every way out of the sandbox an operation might try.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createDataEngine } from "../data/engine.ts";
import type { DataEngine } from "../data/types.ts";
import { AppOperationError } from "./errors.ts";
import { AppOperations, type AppOperationsOptions } from "./operations.ts";
import { appCallRpc } from "./route.ts";
import { testWorkerdBinary } from "./testing/workerd-binary.ts";

const FIXTURE = join(import.meta.dirname, "testing", "issue-tracker");
const root = mkdtempSync(join(tmpdir(), "ao-e2e-"));
const binary = await testWorkerdBinary();
const live: AppOperations[] = [];
let data: DataEngine;

function copyTracker(): string {
  const dir = mkdtempSync(join(root, "app-"));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

function app(operations: string, manifest: Record<string, unknown>, migrations: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(root, "app-"));
  mkdirSync(join(dir, "server"));
  mkdirSync(join(dir, "migrations"));
  writeFileSync(join(dir, "app.json"), JSON.stringify({ name: "Test app", ...manifest }));
  writeFileSync(join(dir, "server", "operations.js"), operations);
  for (const [name, sql] of Object.entries(migrations)) writeFileSync(join(dir, "migrations", name), sql);
  return dir;
}

function operations(options: Partial<AppOperationsOptions> = {}) {
  const ops = new AppOperations({ dataDir: join(root, "data"), binary: async () => binary!, data, ...options });
  live.push(ops);
  return ops;
}

async function failure(work: Promise<unknown>): Promise<AppOperationError> {
  try { await work; } catch (error) { if (error instanceof AppOperationError) return error; throw error; }
  throw new Error("expected a failure");
}

const alive = (pid: number | undefined) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const server = (botId = "scout") => ({ botId, via: "server" as const });

beforeAll(async () => {
  data = createDataEngine({ botFolder: (botId) => join(root, "bots", botId), dataDir: join(root, "bot-data") });
  const db = await data.forBot("scout");
  await db.run("CREATE TABLE customers AS SELECT i AS id, 'customer ' || i AS name FROM range(1, 11) t(i)", { connection: "bot" });
});

afterEach(async () => {
  await Promise.all(live.splice(0).map((ops) => ops.stopAll()));
});

afterAll(async () => {
  await data.closeAll();
});

describe.skipIf(!binary)("app operations", () => {
  it("runs the issue tracker from a page call to SQLite and back", async () => {
    const ops = operations();
    const dir = copyTracker();
    const page = (name: string, input: unknown, engaged: boolean) =>
      appCallRpc({ operations: ops, appDirFor: () => dir }, { botId: "scout", threadId: "t", messageId: "m", params: { name, input }, engaged });

    expect(await page("list", {}, false)).toEqual({ status: 200, body: { result: [] } });
    const unclicked = await page("add", { title: "Sneaky" }, false);
    expect(unclicked.status).toBe(409);
    expect(unclicked.body).toMatchObject({ error: { reason: "needs_click" } });

    expect(await page("add", { title: "Write the spike" }, true)).toEqual({ status: 200, body: { result: { id: 1 } } });
    expect(await page("add", { title: "Measure it", label: "perf" }, true)).toEqual({ status: 200, body: { result: { id: 2 } } });
    expect((await page("add", { title: "" }, true)).body).toMatchObject({ error: { message: "A title is 1 to 200 characters." } });
    expect(await page("setStatus", { id: 1, status: "done" }, true)).toEqual({ status: 200, body: { result: { ok: true } } });
    expect((await page("setStatus", { id: 99, status: "done" }, true)).body).toMatchObject({ error: { message: "No issue 99." } });

    expect((await page("list", { status: "open" }, false)).body).toEqual({ result: [{ id: 2, title: "Measure it", status: "open", label: "perf" }] });
    expect((await page("stats", {}, false)).body).toEqual({ result: { done: 1, open: 1 } });
    expect((await page("nope", {}, true)).status).toBe(404);
    expect(ops.state(dir)?.logs).toEqual(["added 1", "added 2"]);
    expect(ops.state(dir)?.migrations).toEqual([1, 2]);
  });

  it("applies migrations once, across runtime and server restarts", async () => {
    const dir = copyTracker();
    const first = operations();
    await first.run({ appDir: dir, name: "add", input: { title: "kept" }, caller: server() });
    expect(first.state(dir)?.migrations).toEqual([1, 2]);
    await first.stopAll();
    const second = operations();
    expect(await second.run({ appDir: dir, name: "list", input: {}, caller: server() })).toMatchObject([{ title: "kept" }]);
    expect(second.state(dir)?.migrations).toEqual([]);
  });

  it("a failed change is rolled back whole", async () => {
    const ops = operations();
    const dir = app(`
      export async function addTwo(input, ctx) {
        await ctx.db.exec("INSERT INTO t (x) VALUES (1)");
        if (input.fail) throw new Error("second step failed");
        await ctx.db.exec("INSERT INTO t (x) VALUES (2)");
      }
      export async function count(_input, ctx) { return (await ctx.db.query("SELECT count(*) AS n FROM t")).rows[0].n; }
    `, { operations: { addTwo: { kind: "change" }, count: { kind: "read" } } }, { "001_t.sql": "CREATE TABLE t (x INTEGER);" });
    expect((await failure(ops.run({ appDir: dir, name: "addTwo", input: { fail: true }, caller: server() }))).message).toBe("second step failed");
    expect(await ops.run({ appDir: dir, name: "count", input: {}, caller: server() })).toBe(0);
    await ops.run({ appDir: dir, name: "addTwo", input: {}, caller: server() });
    expect(await ops.run({ appDir: dir, name: "count", input: {}, caller: server() })).toBe(2);
  });

  it("an operation reaches no network: public, private, loopback, raw sockets", async () => {
    let knocked = 0;
    const local = createServer((_request, response) => { knocked += 1; response.end("reached"); });
    await new Promise<void>((resolve) => local.listen(0, "127.0.0.1", resolve));
    const port = (local.address() as AddressInfo).port;
    const ops = operations();
    const dir = app(`
      const attempt = async (work) => { try { return "REACHED " + await work(); } catch (error) { return "refused: " + error.message; } };
      export async function escape(input) {
        const { connect } = await import("cloudflare:sockets");
        return {
          https: await attempt(async () => (await fetch("https://example.com")).status),
          publicHttp: await attempt(async () => (await fetch("http://93.184.215.14/")).status),
          loopback: await attempt(async () => (await fetch("http://127.0.0.1:" + input.port + "/")).status),
          localhost: await attempt(async () => (await fetch("http://localhost:" + input.port + "/")).status),
          privateNet: await attempt(async () => (await fetch("http://192.168.1.1/")).status),
          metadata: await attempt(async () => (await fetch("http://169.254.169.254/latest/meta-data/")).status),
          socket: await attempt(async () => { const s = connect("127.0.0.1:" + input.port); await s.opened; return "opened"; }),
        };
      }
    `, { operations: { escape: { kind: "read" } } });
    const result = await ops.run({ appDir: dir, name: "escape", input: { port }, caller: server() }) as Record<string, string>;
    await new Promise<void>((resolve) => local.close(() => resolve()));
    for (const [what, outcome] of Object.entries(result)) expect(outcome, what).toMatch(/^refused: /);
    expect(knocked).toBe(0);
  });

  it("an operation has no Node, no process, no require, no file system", async () => {
    const ops = operations();
    const dir = app(`
      const load = async (name) => { try { await import(name); return "LOADED"; } catch (error) { return "refused: " + error.message; } };
      export async function probe() {
        return {
          process: typeof process, require: typeof require, Deno: typeof Deno, Bun: typeof Bun,
          fs: await load("node:fs"), childProcess: await load("node:child_process"), bareFs: await load("fs"),
          net: await load("node:net"), fileUrl: await load("file:///etc/hosts"),
        };
      }
    `, { operations: { probe: { kind: "read" } } });
    const result = await ops.run({ appDir: dir, name: "probe", input: {}, caller: server() }) as Record<string, string>;
    expect(result).toMatchObject({ process: "undefined", require: "undefined", Deno: "undefined", Bun: "undefined" });
    for (const name of ["fs", "childProcess", "bareFs", "net", "fileUrl"]) expect(result[name], name).toMatch(/^refused: /);
  });

  it("an app's database holds only its own tables: no other app's, no bot's, no files", async () => {
    const ops = operations();
    const tracker = copyTracker();
    await ops.run({ appDir: tracker, name: "add", input: { title: "secret issue" }, caller: server() });
    const trackerDb = join(root, "data", "app-operations", ops.state(tracker)!.id, "app.db");
    const dir = app(`
      const attempt = async (work) => { try { return "REACHED " + JSON.stringify(await work()); } catch (error) { return "refused: " + error.message; } };
      export async function snoop(input, ctx) {
        return {
          otherTable: await attempt(() => ctx.db.query("SELECT * FROM issues")),
          attach: await attempt(() => ctx.db.exec("ATTACH DATABASE ? AS other", [input.other])),
          attachLiteral: await attempt(() => ctx.db.exec("ATTACH DATABASE '" + input.other + "' AS other")),
          vacuumInto: await attempt(() => ctx.db.exec("VACUUM INTO '/tmp/stolen.db'")),
          readfile: await attempt(() => ctx.db.query("SELECT readfile('/etc/hosts')")),
          loadExtension: await attempt(() => ctx.db.query("SELECT load_extension('/tmp/evil')")),
          copyTo: await attempt(() => ctx.db.exec("COPY (SELECT 1) TO '/tmp/out.csv'")),
          pragma: await attempt(() => ctx.db.query("PRAGMA database_list")),
          botData: await attempt(() => ctx.data.query("SELECT * FROM customers")),
        };
      }
    `, { operations: { snoop: { kind: "change" } } }, { "001_mine.sql": "CREATE TABLE mine (x);" });
    const result = await ops.run({ appDir: dir, name: "snoop", input: { other: trackerDb }, caller: server() }) as Record<string, string>;
    expect(result.otherTable).toMatch(/refused: no such table: issues/);
    expect(result.attach).toMatch(/refused: .*(not authorized|too many attached)/);
    expect(result.attachLiteral).toMatch(/refused: .*(not authorized|too many attached)/);
    expect(result.vacuumInto).toMatch(/refused: /);
    expect(result.readfile).toMatch(/refused: no such function: readfile/);
    expect(result.loadExtension).toMatch(/refused: .*not authorized/);
    expect(result.copyTo).toMatch(/refused: .*syntax error/);
    expect(result.pragma).toMatch(/refused: .*not authorized/);
    expect(result.botData).toMatch(/refused: This app did not declare "data"/);
  });

  it("the bot's data is a declared, read-only path through the page gate", async () => {
    const ops = operations();
    const dir = app(`
      const attempt = async (work) => { try { return await work(); } catch (error) { return "refused: " + error.message; } };
      export async function report(_input, ctx) {
        return {
          rows: await attempt(async () => (await ctx.data.query("SELECT count(*) AS n FROM customers")).rows),
          write: await attempt(() => ctx.data.query("INSERT INTO customers VALUES (99, 'x')")),
          file: await attempt(() => ctx.data.query("SELECT * FROM read_csv('/etc/hosts')")),
          connector: await attempt(() => ctx.connectors.call("github", "list_issues", {})),
        };
      }
    `, { uses: ["data", "connectors"], connectors: { github: ["list_issues"] }, operations: { report: { kind: "read" } } });
    const result = await ops.run({ appDir: dir, name: "report", input: {}, caller: server("scout") }) as Record<string, unknown>;
    expect(result.rows).toEqual([{ n: 10 }]);
    expect(result.write).toMatch(/refused: .*SELECT/);
    expect(result.file).toMatch(/refused: .*read_csv/);
    expect(result.connector).toBe("refused: Connector tools are not available to app operations yet.");
  });

  it("a read operation cannot write, by exec or by query", async () => {
    const ops = operations();
    const dir = app(`
      const attempt = async (work) => { try { return "REACHED " + JSON.stringify(await work()); } catch (error) { return "refused: " + error.message; } };
      export async function sneak(_input, ctx) {
        return {
          exec: await attempt(() => ctx.db.exec("INSERT INTO t VALUES (1)")),
          query: await attempt(() => ctx.db.query("INSERT INTO t VALUES (1) RETURNING x")),
          cte: await attempt(() => ctx.db.query("WITH a AS (SELECT 1) UPDATE t SET x = 2")),
          count: (await ctx.db.query("SELECT count(*) AS n FROM t")).rows[0].n,
        };
      }
    `, { operations: { sneak: { kind: "read" } } }, { "001_t.sql": "CREATE TABLE t (x INTEGER);" });
    const result = await ops.run({ appDir: dir, name: "sneak", input: {}, caller: server() }) as Record<string, unknown>;
    expect(result.exec).toMatch(/refused: ctx.db.exec runs only in a change operation/);
    expect(result.query).toMatch(/refused: .*(not authorized|readonly)/);
    expect(result.cte).toMatch(/refused: .*(not authorized|readonly)/);
    expect(result.count).toBe(0);
  });

  it("the host service answers only an app's own secret with a live invocation it issued", async () => {
    const ops = operations();
    const a = app(`
      import { env } from "cloudflare:workers";
      export async function forge(input) {
        const response = await env.HOST.fetch("http://host/db/query", {
          method: "POST",
          headers: { "x-omb-app-secret": input.secret, "x-omb-invocation": input.token, "content-type": "application/json" },
          body: JSON.stringify({ sql: "SELECT * FROM issues" }),
        });
        return { status: response.status, body: await response.text() };
      }
    `, { operations: { forge: { kind: "read" } } });
    const b = copyTracker();
    await ops.run({ appDir: b, name: "add", input: { title: "b's issue" }, caller: server() });
    const bSecret = ops.state(b)!.secret;
    const forged = await ops.run({ appDir: a, name: "forge", input: { secret: bSecret, token: "0".repeat(48) }, caller: server() }) as { status: number; body: string };
    expect(forged.status).toBe(403);
    expect(forged.body).not.toContain("b's issue");
    // workerd replaced the forged header with a's own secret: the host knew the secret, not the token.
    expect(ops.hostService.refused).toEqual(["unknown invocation"]);

    const address = await ops.hostService.start();
    const direct = (headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
      const request = httpRequest({ socketPath: address.slice("unix:".length), path: "/db/query", method: "POST", headers }, (response) => { response.resume(); resolve(response.statusCode ?? 0); });
      request.on("error", reject);
      request.end(JSON.stringify({ sql: "SELECT 1" }));
    });
    expect(await direct({})).toBe(403);
    expect(await direct({ "x-omb-app-secret": bSecret })).toBe(403);
    expect(await direct({ "x-omb-app-secret": bSecret, "x-omb-invocation": "f".repeat(48) })).toBe(403);
    expect(ops.hostService.refused).toEqual(["unknown invocation", "no secret", "no invocation", "unknown invocation"]);
  });

  it("an endless loop is stopped by the operation time limit and the runtime starts again", async () => {
    const ops = operations({ limits: { operationMs: 1_500 } });
    const dir = app(`
      export async function spin() { for (;;) {} }
      export async function ping() { return "pong"; }
    `, { operations: { spin: { kind: "read" }, ping: { kind: "read" } } });
    expect(await ops.run({ appDir: dir, name: "ping", input: {}, caller: server() })).toBe("pong");
    const pid = ops.state(dir)!.pid;
    const started = performance.now();
    const stopped = await failure(ops.run({ appDir: dir, name: "spin", input: {}, caller: server() }));
    const took = performance.now() - started;
    expect(stopped.code).toBe("timeout");
    expect(took).toBeGreaterThanOrEqual(1_450);
    expect(took).toBeLessThan(4_000);
    expect(alive(pid)).toBe(false);
    expect(await ops.run({ appDir: dir, name: "ping", input: {}, caller: server() })).toBe("pong");
    expect(ops.state(dir)!.starts).toBe(2);
  });

  it("unbounded memory aborts the app's own process at the heap cap, and the next call restarts it", async () => {
    const ops = operations({ limits: { heapMb: 64 } });
    const dir = app(`
      export async function hog() { const keep = []; for (;;) keep.push(new Array(1e6).fill(1)); }
      export async function buffers() { const keep = []; for (let i = 0; i < 64; i++) keep.push(new Uint8Array(64 * 1024 * 1024).fill(1)); return keep.length; }
      export async function ping() { return "pong"; }
    `, { operations: { hog: { kind: "read" }, buffers: { kind: "read" }, ping: { kind: "read" } } });
    const other = copyTracker();
    await ops.run({ appDir: other, name: "list", input: {}, caller: server() });
    const otherPid = ops.state(other)!.pid;
    const started = performance.now();
    const crashed = await failure(ops.run({ appDir: dir, name: "hog", input: {}, caller: server() }));
    const took = performance.now() - started;
    expect(crashed.code).toBe("runtime_stopped");
    expect(took).toBeLessThan(5_000);
    expect(ops.state(dir)!.crashes).toBe(1);
    expect(ops.state(dir)!.logs.join("\n")).toMatch(/heap/i);
    expect(alive(otherPid)).toBe(true);
    expect(await ops.run({ appDir: dir, name: "ping", input: {}, caller: server() })).toBe("pong");
    const pid = ops.state(dir)!.pid;
    const bufferStart = performance.now();
    const outsideHeap = await failure(ops.run({ appDir: dir, name: "buffers", input: {}, caller: server() }));
    const bufferTook = performance.now() - bufferStart;
    expect(outsideHeap.code).toBe("memory");
    expect(alive(pid)).toBe(false);
    expect(alive(otherPid)).toBe(true);
    expect(await ops.run({ appDir: dir, name: "ping", input: {}, caller: server() })).toBe("pong");
    console.info(`[app-operations] heap hog aborted by V8 after ${took.toFixed(0)} ms; ArrayBuffer hog killed by the RSS watchdog after ${bufferTook.toFixed(0)} ms`);
  });

  it("a change whose database was stopped mid-way is never reported as committed", async () => {
    const ops = operations({ limits: { statementMs: 1_000 } });
    const dir = app(`
      export async function swallow(_input, ctx) {
        await ctx.db.exec("INSERT INTO t (x) SELECT value FROM generate_series(1, 3000)").catch(() =>
          ctx.db.exec("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 3000) INSERT INTO t (x) SELECT x FROM c"));
        try { await ctx.db.query("SELECT count(*) FROM t a, t b, t c"); } catch (error) { ctx.log("caught: " + error.message); }
        return "pretend all is well";
      }
      export async function count(_input, ctx) { return (await ctx.db.query("SELECT count(*) AS n FROM t")).rows[0].n; }
    `, { operations: { swallow: { kind: "change" }, count: { kind: "read" } } }, { "001_t.sql": "CREATE TABLE t (x INTEGER);" });
    const refused = await failure(ops.run({ appDir: dir, name: "swallow", input: {}, caller: server() }));
    expect(refused.code).toBe("database_stopped");
    expect(ops.state(dir)!.logs.join("\n")).toMatch(/caught: A statement ran past 1 seconds/);
    expect(await ops.run({ appDir: dir, name: "count", input: {}, caller: server() })).toBe(0);
  });

  it("stops after idle", async () => {
    const ops = operations({ idleMs: 200 });
    const dir = app(`export async function version() { return 1; }`, { operations: { version: { kind: "read" } } });
    const idle = new Promise((resolve) => ops.once("stopped", resolve));
    expect(await ops.run({ appDir: dir, name: "version", input: {}, caller: server() })).toBe(1);
    const pid = ops.state(dir)!.pid;
    expect(await idle).toMatchObject({ reason: "idle", pid });
    expect(alive(pid)).toBe(false);
    expect(await ops.run({ appDir: dir, name: "version", input: {}, caller: server() })).toBe(1);
    expect(ops.state(dir)!.starts).toBe(2);
  });

  it("reloads when server/operations.js changes", async () => {
    const ops = operations();
    const dir = app(`export async function version() { return 1; }`, { operations: { version: { kind: "read" } } });
    expect(await ops.run({ appDir: dir, name: "version", input: {}, caller: server() })).toBe(1);
    const pid = ops.state(dir)!.pid;
    const reload = new Promise((resolve) => ops.once("stopped", resolve));
    writeFileSync(join(dir, "server", "operations.js"), "export async function version() { return 2; }\n");
    expect(await ops.run({ appDir: dir, name: "version", input: {}, caller: server() })).toBe(2);
    expect(await reload).toMatchObject({ reason: "reload", pid });
    expect(ops.state(dir)!.pid).not.toBe(pid);
  });

  it("two apps are two processes with two databases", async () => {
    const ops = operations();
    const [a, b] = [copyTracker(), copyTracker()];
    await ops.run({ appDir: a, name: "add", input: { title: "only in a" }, caller: server() });
    expect(await ops.run({ appDir: b, name: "list", input: {}, caller: server() })).toEqual([]);
    expect(await ops.run({ appDir: a, name: "list", input: {}, caller: server() })).toMatchObject([{ title: "only in a" }]);
    const [sa, sb] = [ops.state(a)!, ops.state(b)!];
    expect(sa.pid).not.toBe(sb.pid);
    expect(sa.dbPid).not.toBe(sb.dbPid);
    expect(sa.secret).not.toBe(sb.secret);
  });

  it("leaves no process behind when it stops", async () => {
    const ops = operations();
    const dir = copyTracker();
    await ops.run({ appDir: dir, name: "list", input: {}, caller: server() });
    const { pid, dbPid } = ops.state(dir)!;
    expect(alive(pid) && alive(dbPid)).toBe(true);
    await ops.stopAll();
    expect(alive(pid)).toBe(false);
    expect(alive(dbPid)).toBe(false);
    expect((await failure(ops.run({ appDir: dir, name: "list", input: {}, caller: server() }))).code).toBe("runtime_stopped");
  });

  it("stopping while a runtime is still starting leaves nothing behind", async () => {
    const ops = operations();
    const dir = copyTracker();
    const pids: number[] = [];
    ops.on("started", (event: { pid: number }) => pids.push(event.pid));
    const call = ops.run({ appDir: dir, name: "list", input: {}, caller: server() }).catch((error) => (error as AppOperationError).code);
    await ops.stopAll();
    expect(await call).toBe("runtime_stopped");
    expect(pids.filter(alive)).toEqual([]);
    expect(ops.state(dir)?.pid).toBeUndefined();
  });

  it("refuses too many operations of one app at once", async () => {
    const ops = operations({ limits: { concurrent: 2 } });
    const dir = app(`export async function wait(input, ctx) { await ctx.db.query("SELECT 1"); await new Promise((r) => setTimeout(r, input.ms)); return 1; }`, { operations: { wait: { kind: "read" } } });
    const calls = [1, 2, 3].map(() => ops.run({ appDir: dir, name: "wait", input: { ms: 300 }, caller: server() }).then(() => "ok", (error) => (error as AppOperationError).code));
    expect((await Promise.all(calls)).sort()).toEqual(["busy", "ok", "ok"]);
  });

  it.skipIf(process.platform === "win32")("a server killed outright leaves workerd behind, which the next start sweeps", async () => {
    const dir = copyTracker();
    const dataDir = join(root, "orphan-data");
    const script = `
      import { AppOperations } from ${JSON.stringify(join(import.meta.dirname, "operations.ts"))};
      const ops = new AppOperations({ dataDir: ${JSON.stringify(dataDir)}, binary: async () => ${JSON.stringify(binary)} });
      await ops.run({ appDir: ${JSON.stringify(dir)}, name: "list", input: {}, caller: { botId: "b", via: "server" } });
      const s = ops.state(${JSON.stringify(dir)});
      console.log(JSON.stringify({ pid: s.pid, dbPid: s.dbPid }));
      setInterval(() => {}, 1000);
    `;
    const parent = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    const line = await new Promise<string>((resolve) => parent.stdout!.once("data", (chunk: Buffer) => resolve(chunk.toString())));
    const { pid, dbPid } = JSON.parse(line) as { pid: number; dbPid: number };
    const parentGone = new Promise((resolve) => parent.once("exit", resolve));
    parent.kill("SIGKILL");
    await parentGone;
    expect(alive(pid)).toBe(true);
    const isWorkerd = (candidate: number) => { try { return /workerd/.test(execFileSync("/bin/ps", ["-o", "comm=", "-p", String(candidate)]).toString()); } catch { return false; } };
    expect(AppOperations.sweepOrphans(dataDir, isWorkerd)).toEqual([pid]);
    await new Promise<void>((resolve) => { const check = () => alive(pid) ? setImmediate(check) : resolve(); check(); });
    await new Promise<void>((resolve) => { const check = () => alive(dbPid) ? setImmediate(check) : resolve(); check(); });
    expect(AppOperations.sweepOrphans(dataDir, isWorkerd)).toEqual([]);
  });
});
