// Measures app operations on this computer: `node server/app-operations/bench.ts <workerd.gz>` with HOME, OMB_DATA_DIR
// and TMPDIR pointed at throwaway folders. The .gz is the pinned release asset, already on disk; ensureRuntime verifies it.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { AppOperations } from "./operations.ts";
import { ensureRuntime } from "./runtime.ts";

const gz = process.argv[2];
if (!gz) throw new Error("usage: node server/app-operations/bench.ts <path to workerd-<platform>.gz>");
const root = mkdtempSync(join(tmpdir(), "ao-bench-"));
const dataDir = join(root, "data");

const fetchStarted = performance.now();
const binary = await ensureRuntime({ dataDir, fetch: async () => { const data = readFileSync(gz); return { ok: true, status: 200, arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer }; } });
const verifyMs = performance.now() - fetchStarted;

const app = join(root, "bench-app");
mkdirSync(join(app, "server"), { recursive: true });
mkdirSync(join(app, "migrations"));
writeFileSync(join(app, "app.json"), JSON.stringify({ name: "Bench", operations: { echo: { kind: "read" }, one: { kind: "read" }, thousand: { kind: "read" }, insert: { kind: "change" }, insert100: { kind: "change" } } }));
writeFileSync(join(app, "migrations", "001_t.sql"), "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, amount REAL, at TEXT);");
writeFileSync(join(app, "server", "operations.js"), `
export async function echo(input) { return input; }
export async function one(_input, ctx) { return (await ctx.db.query("SELECT 1 AS one")).rows[0].one; }
export async function thousand(_input, ctx) { return (await ctx.db.query("SELECT id, name, amount, at FROM t ORDER BY id LIMIT 1000")).rows.length; }
export async function insert(input, ctx) { return (await ctx.db.exec("INSERT INTO t (name, amount, at) VALUES (?, ?, ?)", [input.name, input.amount, "2026-11-26"])).lastInsertRowid; }
export async function insert100(input, ctx) { for (let i = 0; i < 100; i++) await ctx.db.exec("INSERT INTO t (name, amount, at) VALUES (?, ?, ?)", [input.name + i, i, "2026-11-26"]); return 100; }
`);

const caller = { botId: "bench", via: "server" as const };
// The first start of a freshly written binary includes the OS's first-run scan of it; later starts do not.
const firstOps = new AppOperations({ dataDir, binary: async () => binary, idleMs: 600_000 });
const firstAt = performance.now();
await firstOps.run({ appDir: app, name: "echo", input: {}, caller });
const firstEverMs = performance.now() - firstAt;
await firstOps.stopAll();
const ops = new AppOperations({ dataDir, binary: async () => binary, idleMs: 600_000 });
const run = (name: string, input: unknown = {}) => ops.run({ appDir: app, name, input, caller });

const percentile = (values: number[], p: number) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!; };
async function timed(name: string, times: number, work: () => Promise<unknown>) {
  const samples: number[] = [];
  for (let i = 0; i < times; i++) { const at = performance.now(); await work(); samples.push(performance.now() - at); }
  return { name, n: times, p50: +percentile(samples, 0.5).toFixed(2), p95: +percentile(samples, 0.95).toFixed(2) };
}
const rssMb = (pid: number | undefined) => pid ? Number(execFileSync("/bin/ps", ["-o", "rss=", "-p", String(pid)]).toString().trim()) / 1024 : null;

let started = 0;
ops.once("started", () => { started = performance.now(); });
const coldAt = performance.now();
await run("echo", { hello: 1 });
const coldMs = performance.now() - coldAt;
const workerdStartMs = started - coldAt;
const state = ops.state(app)!;
const idle = { workerdMb: rssMb(state.pid) };
await run("one");
const afterFirstQuery = { workerdMb: rssMb(ops.state(app)!.pid), dbProcessMb: rssMb(ops.state(app)!.dbPid) };

for (let i = 0; i < 20; i++) await run("echo", { i });
const results = [await timed("trivial operation (no db)", 200, () => run("echo", { i: 1 }))];
results.push(await timed("operation with one SELECT 1", 200, () => run("one")));
results.push(await timed("single insert (change operation, own transaction)", 100, () => run("insert", { name: "x", amount: 1.5 })));
results.push(await timed("100 inserts in one change operation", 20, () => run("insert100", { name: "bulk" })));
results.push(await timed("1,000-row read", 50, () => run("thousand")));
const busy = { workerdMb: rssMb(ops.state(app)!.pid), dbProcessMb: rssMb(ops.state(app)!.dbPid) };
await ops.stopAll();

// The same work on node:sqlite in this process, for the cost of the sandbox and the two hops.
const direct = new DatabaseSync(join(root, "direct.db"));
direct.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, amount REAL, at TEXT);");
const insertStatement = direct.prepare("INSERT INTO t (name, amount, at) VALUES (?, ?, ?)");
const baseline = [
  await timed("in-process node:sqlite: single insert", 100, async () => { direct.exec("BEGIN IMMEDIATE"); insertStatement.run("x", 1.5, "2026-11-26"); direct.exec("COMMIT"); }),
  await timed("in-process node:sqlite: 100 inserts in one transaction", 20, async () => { direct.exec("BEGIN IMMEDIATE"); for (let i = 0; i < 100; i++) insertStatement.run("b" + i, i, "2026-11-26"); direct.exec("COMMIT"); }),
  await timed("in-process node:sqlite: 1,000-row read", 50, async () => direct.prepare("SELECT id, name, amount, at FROM t ORDER BY id LIMIT 1000").all()),
];
direct.close();

// DuckDB for the same small writes, as the app database would have been.
const duck = await import("@duckdb/node-api");
const instance = await duck.DuckDBInstance.create(join(root, "app.duckdb"));
const conn = await instance.connect();
await conn.run("CREATE TABLE t (id INTEGER, name VARCHAR, amount DOUBLE, ts VARCHAR)");
let nextId = 0;
const duckdb = [
  await timed("DuckDB: single insert (own transaction)", 100, () => conn.run("INSERT INTO t VALUES ($1, $2, $3, $4)", [++nextId, "x", 1.5, "2026-11-26"])),
  await timed("DuckDB: 100 inserts in one transaction", 20, async () => { await conn.run("BEGIN"); for (let i = 0; i < 100; i++) await conn.run("INSERT INTO t VALUES ($1, $2, $3, $4)", [++nextId, "b", i, "2026-11-26"]); await conn.run("COMMIT"); }),
  await timed("DuckDB: 1,000-row read", 50, async () => (await conn.runAndReadAll("SELECT * FROM t ORDER BY id LIMIT 1000")).getRowObjectsJson()),
];
let secondProcess = "";
try {
  execFileSync(process.execPath, ["-e", `import("@duckdb/node-api").then(async (d) => { await d.DuckDBInstance.create(${JSON.stringify(join(root, "app.duckdb"))}, { access_mode: "READ_ONLY" }); console.log("opened"); })`], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  secondProcess = "a second process opened it read-only";
} catch (error) {
  secondProcess = `a second process could not open it, even read-only: ${String((error as { stderr?: Buffer }).stderr ?? "").split("\n").find((line) => /lock|Conflicting/i.test(line))?.trim() ?? "failed"}`;
}
conn.closeSync();
instance.closeSync();

console.log(JSON.stringify({
  binaryMb: +(statSync(binary).size / 1048576).toFixed(1),
  verifyAndUnpackMs: +verifyMs.toFixed(0),
  firstEverStartMs: +firstEverMs.toFixed(1),
  coldFirstCallMs: +coldMs.toFixed(1),
  workerdSpawnedAfterMs: +workerdStartMs.toFixed(1),
  idle, afterFirstQuery, busy, results, baseline, duckdb, duckdbSecondProcess: secondProcess,
}, null, 2));
