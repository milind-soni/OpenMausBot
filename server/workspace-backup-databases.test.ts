// The databases a full backup carries are taken whole, as the server would read them: every SQLite database by the
// snapshot SQLite makes while a writer goes on, and each bot's Data tables once the engine has let go of them.
import { createCipheriv, createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type * as DuckDB from "@duckdb/node-api";
import { afterEach, describe, expect, it } from "vitest";

import { DATA_RESULTS_SCHEMA } from "../shared/data-surface.ts";
import { createDataEngine } from "./data/engine.ts";
import { openRuntimeStore } from "./runtime/store.ts";
import { applyPendingWorkspaceRestore, commitPendingWorkspaceRestore, createWorkspaceBackup, stageWorkspaceBackup } from "./workspace-backup.ts";
import { ONE_STEP, releaseDataForBackup, snapshotDatabases, tooLargeError } from "./workspace-backup-databases.ts";

const PASSWORD = "correct horse battery staple";
// Real encrypted backups: a few seconds here, much longer on the Windows runners.
const TIMEOUT_MS = 120_000;
const scratch: string[] = [];
// Windows keeps a just-closed file busy for a moment; rm retries EBUSY/EPERM.
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
const directory = () => { const path = mkdtempSync(join(tmpdir(), "omb-backup-databases-")); scratch.push(path); return path; };

async function restored(backup: string): Promise<string> {
  const target = directory();
  const staged = await stageWorkspaceBackup(target, backup, { password: PASSWORD });
  commitPendingWorkspaceRestore(target, staged.id);
  expect(applyPendingWorkspaceRestore(target)).toMatchObject({ restored: true });
  return target;
}

const PAD = "x".repeat(2_000);
/** A database as the server keeps it: WAL mode, its rows still in the WAL, and a connection that goes on writing. */
function liveDatabase(path: string, schema: string, insert: string, rows: number) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA wal_autocheckpoint = 0");
  db.exec(schema);
  const statement = db.prepare(insert);
  let next = 0;
  const write = () => { statement.run(next, PAD); next++; };
  db.exec("BEGIN");
  for (let i = 0; i < rows; i++) write();
  db.exec("COMMIT");
  return { db, write, written: () => next };
}

/** The rows a restored database holds: whole (integrity), and every one from the first, none skipped. */
function rowsOf(path: string, sql: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    const ids = db.prepare(sql).all().map((row) => Number(Object.values(row)[0]));
    expect(ids).toEqual(ids.map((_, i) => i));
    return ids.length;
  } finally { db.close(); }
}

describe("SQLite databases in a full backup", () => {
  it("snapshots in one step at a rate every Node takes: a positive Int32", async () => {
    expect(Number.isInteger(ONE_STEP) && ONE_STEP >= 1 && ONE_STEP <= 2 ** 31 - 1).toBe(true);
    const root = directory(), snapshot = directory();
    liveDatabase(join(root, "bursts.db"), "CREATE TABLE probe(i INTEGER PRIMARY KEY, pad TEXT)", "INSERT INTO probe VALUES (?, ?)", 20).db.close();
    await snapshotDatabases(root, snapshot);
    expect(rowsOf(join(snapshot, "bursts-snapshot.db"), "SELECT i FROM probe ORDER BY i")).toBe(20);
  });

  it("restores each database whole and complete while a writer goes on inserting into it", async () => {
    const source = directory();
    // A big file before the databases keeps the copy going while the writers write.
    mkdirSync(join(source, "attachments"));
    writeFileSync(join(source, "attachments", "big.bin"), Buffer.alloc(32 * 1024 * 1024, 0x5a));
    openRuntimeStore(join(source, "runtime.db")).close();
    const live = [
      liveDatabase(join(source, "messages.db"),
        "CREATE TABLE messages(thread_id TEXT, id INTEGER, text TEXT, json TEXT, PRIMARY KEY(thread_id, id)); CREATE TABLE thread_state(thread_id TEXT PRIMARY KEY, active_leaf_id TEXT)",
        "INSERT INTO messages VALUES ('thread', ?, ?, '{}')", 400),
      liveDatabase(join(source, "runtime.db"), "CREATE TABLE probe(i INTEGER PRIMARY KEY, pad TEXT)", "INSERT INTO probe VALUES (?, ?)", 400),
      liveDatabase(join(source, "bursts.db"), "CREATE TABLE probe(i INTEGER PRIMARY KEY, pad TEXT)", "INSERT INTO probe VALUES (?, ?)", 400),
    ];
    const before = live.map((database) => database.written());
    const writer = setInterval(() => { for (const database of live) database.write(); }, 1);
    let backup: string;
    try {
      backup = (await createWorkspaceBackup(source, { password: PASSWORD })).path;
    } finally {
      clearInterval(writer);
      for (const database of live) database.db.close();
    }
    expect(live.every((database, i) => database.written() > before[i]!)).toBe(true);
    const target = await restored(backup);
    const counts = [
      rowsOf(join(target, "messages.db"), "SELECT id FROM messages ORDER BY id"),
      rowsOf(join(target, "runtime.db"), "SELECT i FROM probe ORDER BY i"),
      rowsOf(join(target, "bursts.db"), "SELECT i FROM probe ORDER BY i"),
    ];
    counts.forEach((count, i) => expect(count).toBeGreaterThanOrEqual(before[i]!));
    // Each arrives as one file: no log of the source's beside it for SQLite to apply or drop.
    expect(readdirSync(target).filter((name) => /\.db-(?:wal|shm)$/.test(name))).toEqual([]);
  }, TIMEOUT_MS);
});

const duck = createRequire(import.meta.url)("@duckdb/node-api") as typeof DuckDB;

/** Everything a bot's Data tables hold, read straight from the file: columns and their types, views, and every row. */
async function dataTables(file: string) {
  const instance = await duck.DuckDBInstance.create(file, { access_mode: "READ_ONLY" });
  const connection = await instance.connect();
  const read = async (sql: string) => (await connection.runAndReadAll(sql)).getRowsJson();
  try {
    return {
      columns: await read("SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns ORDER BY ALL"),
      views: await read("SELECT schema_name, view_name, sql FROM duckdb_views() WHERE NOT internal ORDER BY ALL"),
      rows: await read("SELECT * FROM main.measures ORDER BY id"),
      bytes: await read("SELECT id, hex(raw) FROM main.measures ORDER BY id"),
      view: await read("SELECT * FROM main.large ORDER BY id"),
      result: await read(`SELECT * FROM ${DATA_RESULTS_SCHEMA}.top ORDER BY id`),
    };
  } finally { connection.closeSync(); instance.closeSync(); }
}

const MEASURES = `CREATE TABLE measures(id INTEGER, amount DECIMAL(18,3), seen TIMESTAMPTZ, big HUGEINT, tags VARCHAR[], point STRUCT(x DOUBLE, y DOUBLE), raw BLOB, note VARCHAR);
INSERT INTO measures VALUES
  (1, 12.345, TIMESTAMPTZ '2026-11-20 09:30:00+05:30', 170141183460469231731687303715884105727, ['a', 'b'], {'x': 1.5, 'y': -2.25}, '\\x00\\xFF\\x10'::BLOB, 'first'),
  (2, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  (3, -0.001, TIMESTAMPTZ '1999-12-31 23:59:59.999999+00', -170141183460469231731687303715884105728, [], {'x': NULL, 'y': 0}, ''::BLOB, 'naïve ☃');
CREATE VIEW large AS SELECT id, big FROM measures WHERE big > 0;`;

describe("a bot's Data tables in a full backup", () => {
  it("round-trips them exactly: columns, types, views, rows, and what the engine had not yet written into the file", async () => {
    const source = directory();
    const env = { ...process.env, OMB_DUCKDB_DIR: undefined, OMB_RESOURCES_PATH: undefined };
    const engine = createDataEngine({ botFolder: (id) => join(source, "bots", id), dataDir: source, env });
    try {
      const database = await engine.forBot("b1");
      for (const statement of MEASURES.split(";").map((sql) => sql.trim()).filter(Boolean)) await database.run(statement, { connection: "bot" });
      await database.materialise("SELECT id, amount FROM measures WHERE amount IS NOT NULL", "top", { connection: "bot" });
      writeFileSync(join(source, "bots", "b1", "SOUL.md"), "Keeps the numbers.");
      // The engine holds its newest work in the WAL beside the file: a copy of the file alone would lose it.
      expect(existsSync(join(source, "bots", "b1", "data.duckdb.wal"))).toBe(true);
      // What the maintenance gate does before the backup starts.
      await releaseDataForBackup(engine);
      expect(existsSync(join(source, "bots", "b1", "data.duckdb.wal"))).toBe(false);
      const exported = await createWorkspaceBackup(source, { password: PASSWORD });
      const target = await restored(exported.path);
      const want = await dataTables(join(source, "bots", "b1", "data.duckdb"));
      expect(want.rows).toHaveLength(3);
      expect(want.rows[0]).toContain("170141183460469231731687303715884105727");
      expect(want.bytes).toEqual([[1, "00FF10"], [2, null], [3, ""]]);
      expect(want.views).toHaveLength(1);
      expect(want.result).toHaveLength(2);
      expect(await dataTables(join(target, "bots", "b1", "data.duckdb"))).toEqual(want);
      expect(readFileSync(join(target, "bots", "b1", "SOUL.md"), "utf8")).toBe("Keeps the numbers.");
      // The bot's database opens again on its next statement, here as before.
      expect((await database.run("SELECT count(*) AS n FROM measures", { connection: "panel" })).rows).toEqual([["3"]]);
    } finally { await engine.closeAll(); }
  }, TIMEOUT_MS);

  // Copies the files from under an open instance, which Windows' file sharing may refuse.
  it.skipIf(process.platform === "win32")("carries a database and its WAL as they lie when no engine holds them, as after a crash, and DuckDB applies the WAL", async () => {
    const source = directory();
    const folder = join(source, "bots", "b2");
    mkdirSync(folder, { recursive: true });
    const instance = await duck.DuckDBInstance.create(join(folder, "data.duckdb"));
    const connection = await instance.connect();
    try {
      for (const statement of MEASURES.split(";").map((sql) => sql.trim()).filter(Boolean)) await connection.run(statement);
      await connection.run(`CREATE SCHEMA ${DATA_RESULTS_SCHEMA}; CREATE TABLE ${DATA_RESULTS_SCHEMA}.top AS SELECT id, amount FROM measures WHERE amount IS NOT NULL`);
      // A process that stopped here leaves both files: the pair is the database.
      const crashed = join(source, "bots", "b3");
      mkdirSync(crashed);
      for (const name of ["data.duckdb", "data.duckdb.wal"]) copyFileSync(join(folder, name), join(crashed, name));
    } finally { connection.closeSync(); instance.closeSync(); }
    rmSync(folder, { recursive: true, maxRetries: 20, retryDelay: 100 });
    const exported = await createWorkspaceBackup(source, { password: PASSWORD });
    const target = await restored(exported.path);
    expect(readdirSync(join(target, "bots", "b3")).sort()).toEqual(["data.duckdb", "data.duckdb.wal"]);
    const tables = await dataTables(join(target, "bots", "b3", "data.duckdb"));
    expect(tables.rows).toHaveLength(3);
    expect(tables.result).toHaveLength(2);
  }, TIMEOUT_MS);

  it("says which bot's Data query holds its database, and that a restart ends it", async () => {
    const running = await releaseDataForBackup({ release: async () => [{ botId: "b1", why: "running" }] }, () => "Ledger").catch((error: unknown) => error);
    expect(running).toMatchObject({ status: 409, errorKey: "serverError.backup.dataQueryRunning", errorParams: { bot: "Ledger" } });
    expect((running as Error).message).toBe("Ledger's Data query is still running and did not stop when asked. Fully quit and reopen OpenMausBot (or restart the hosted server) to stop it, then try again.");
    const failed = await releaseDataForBackup({ release: async () => [{ botId: "b1", why: "failed", detail: "IO Error: disk full" }] }).catch((error: unknown) => error);
    expect(failed).toMatchObject({ status: 409, errorKey: "serverError.backup.dataCloseFailed" });
    expect((failed as Error).message).toContain("b1's Data tables could not be closed for the backup (IO Error: disk full).");
    await expect(releaseDataForBackup({ release: async () => [] })).resolves.toBeUndefined();
  });

  it("never opens a second instance on a file a statement that did not stop still holds, and reports it until it closes", async () => {
    // A statement DuckDB does not stop (seen on Windows): the engine keeps its instance, and every statement meanwhile,
    // even one that asked while the release was draining, goes to that same instance.
    let finish = () => {};
    let created = 0, closed = 0, closeFails = 0;
    const result = { statementType: 1, chunkCount: 0, columnCount: 0, rowCount: 0 };
    const connection = () => ({
      run: async (sql: string) => sql === "SELECT stuck" ? new Promise((resolve) => { finish = () => resolve(result); }) : result,
      runAndReadAll: async () => ({ getRowsJson: () => [] }),
      interrupt() {},
      closeSync() { if (closeFails > 0) { closeFails--; throw new Error("IO Error: could not write the checkpoint"); } },
    });
    const binding = {
      version: () => "fake",
      DuckDBInstance: { create: async () => { created++; return { connect: async () => connection(), closeSync() { closed++; } }; } },
      StatementType: { SELECT: 1, EXPLAIN: 2 },
    } as unknown as NonNullable<Parameters<typeof createDataEngine>[0]>["binding"];
    const engine = createDataEngine({ botFolder: (id) => join(directory(), id), dataDir: directory(), binding });
    const database = await engine.forBot("b1");
    const running = database.run("SELECT stuck", { connection: "bot", timeoutMs: 120_000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const releasing = engine.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const during = database.run("SELECT 1", { connection: "panel" });
    expect(await releasing).toEqual([{ botId: "b1", why: "running" }]);
    await during;
    await database.run("SELECT 2", { connection: "panel" });
    expect(created).toBe(1);
    expect(await engine.release()).toEqual([{ botId: "b1", why: "running" }]);
    expect(closed).toBe(0);
    finish();
    await running;
    // A close that throws leaves the instance tracked, said with DuckDB's words, and tried again next time.
    closeFails = 1;
    expect(await engine.release()).toEqual([{ botId: "b1", why: "failed", detail: "IO Error: could not write the checkpoint" }]);
    await database.run("SELECT 3", { connection: "panel" });
    expect(created).toBe(1);
    expect(await engine.release()).toEqual([]);
    expect(closed).toBe(1);
    await database.run("SELECT 4", { connection: "panel" });
    expect(created).toBe(2);
    await engine.closeAll();
  }, TIMEOUT_MS);
});

/** A backup as releases before this one made it (the same format): its SQLite databases copied raw, a WAL beside its
 * bursts database, and no Data tables. */
function legacyBackup(source: string, out: string): string {
  const stage = directory();
  const entries: Array<{ path: string; type: "file" | "directory"; size: number; mode: number; sha256?: string }> = [];
  const walk = (from: string, prefix = "") => {
    for (const name of readdirSync(from).sort()) {
      const path = prefix ? `${prefix}/${name}` : name;
      const full = join(from, name);
      if (lstatSync(full).isDirectory()) {
        entries.push({ path, type: "directory", size: 0, mode: 0o700 });
        mkdirSync(join(stage, "data", path), { recursive: true });
        walk(full, path);
      } else {
        const bytes = readFileSync(full);
        entries.push({ path, type: "file", size: bytes.length, mode: 0o600, sha256: createHash("sha256").update(bytes).digest("hex") });
        writeFileSync(join(stage, "data", path), bytes);
      }
    }
  };
  mkdirSync(join(stage, "data"));
  walk(source);
  const files = entries.filter((entry) => entry.type === "file");
  writeFileSync(join(stage, "manifest.json"), JSON.stringify({
    summary: { format: "openmaus.workspace-backup", version: 1, id: randomUUID(), createdAt: new Date().toISOString(), appVersion: "0.1.174",
      files: files.length, directories: entries.length - files.length, bytes: files.reduce((sum, entry) => sum + entry.size, 0),
      bots: 0, groups: 0, threads: 0, messages: 0, exclusions: [], warnings: [] },
    sourceDataDir: source, clientState: {}, entries,
  }));
  const tar = createRequire(import.meta.url)("tar") as typeof import("tar");
  const plain = join(out, "legacy.tar");
  tar.c({ cwd: stage, portable: true, strict: true, sync: true, file: plain }, ["manifest.json", "data"]);
  const salt = randomBytes(16), iv = randomBytes(12);
  const header = Buffer.concat([Buffer.from("OMB-WORKSPACE-1\n"), salt, iv]);
  const cipher = createCipheriv("aes-256-gcm", scryptSync(PASSWORD, salt, 32, { N: 131_072, r: 8, p: 1, maxmem: 256 * 1024 ** 2 }), iv);
  cipher.setAAD(header);
  const path = join(out, "legacy.ombbackup");
  writeFileSync(path, Buffer.concat([header, cipher.update(readFileSync(plain)), cipher.final(), cipher.getAuthTag()]));
  return path;
}

describe("the 10 GB limit", () => {
  it("says how much of it is Data tables when they are most of it", () => {
    expect(tooLargeError(11 * 1024 ** 3, 3 * 1024 ** 3).message).toBe("The workspace exceeds the 10 GB backup limit.");
    const data = tooLargeError(11 * 1024 ** 3, 7.4 * 1024 ** 3);
    expect(data).toMatchObject({ errorKey: "serverError.backup.tooLargeData", errorParams: { size: "7.4 GB" } });
    expect(data.message).toBe("This installation exceeds the 10 GB backup limit; 7.4 GB of it is bots' Data tables.");
  });
});

describe("backups older releases made", () => {
  it("still restore: a raw bursts database and its WAL arrive as one database, and a backup without Data tables restores without them", async () => {
    const live = directory();
    const { db } = liveDatabase(join(live, "bursts.db"), "CREATE TABLE probe(i INTEGER PRIMARY KEY, pad TEXT)", "INSERT INTO probe VALUES (?, ?)", 50);
    const source = directory();
    try {
      // Taken as older releases took it: each file copied as it lay, the rows still in the WAL.
      for (const name of ["bursts.db", "bursts.db-wal", "bursts.db-shm"]) copyFileSync(join(live, name), join(source, name));
    } finally { db.close(); }
    mkdirSync(join(source, "bots", "b1"), { recursive: true });
    writeFileSync(join(source, "bots", "b1", "SOUL.md"), "Older soul.");
    writeFileSync(join(source, "notes.md"), "kept");
    const backup = legacyBackup(source, directory());
    const target = directory();
    // The destination's own Data tables and live burst log: the restore replaces them, and keeps them in its safety copy.
    mkdirSync(join(target, "bots", "b1"), { recursive: true });
    writeFileSync(join(target, "bots", "b1", "data.duckdb"), "destination tables");
    writeFileSync(join(target, "bursts.db-wal"), "destination log");
    const staged = await stageWorkspaceBackup(target, backup, { password: PASSWORD });
    commitPendingWorkspaceRestore(target, staged.id);
    const result = applyPendingWorkspaceRestore(target);
    expect(result).toMatchObject({ restored: true });
    expect(rowsOf(join(target, "bursts.db"), "SELECT i FROM probe ORDER BY i")).toBe(50);
    expect(readdirSync(target).filter((name) => name.startsWith("bursts.db")).sort()).toEqual(["bursts.db"]);
    expect(readFileSync(join(target, "notes.md"), "utf8")).toBe("kept");
    expect(readdirSync(join(target, "bots", "b1"))).toEqual(["SOUL.md"]);
    expect(readFileSync(join(result.safetyCopyPath!, "data", "bots", "b1", "data.duckdb"), "utf8")).toBe("destination tables");
  }, TIMEOUT_MS);

  it("refuses one whose bursts database is damaged with words a person can act on, changing nothing", async () => {
    const source = directory();
    writeFileSync(join(source, "bursts.db"), "not a database at all, but long enough to be read as a header by SQLite........");
    writeFileSync(join(source, "bursts.db-wal"), "nor a log");
    writeFileSync(join(source, "notes.md"), "kept");
    const backup = legacyBackup(source, directory());
    const target = directory();
    writeFileSync(join(target, "notes.md"), "here");
    const staged = await stageWorkspaceBackup(target, backup, { password: PASSWORD });
    expect(() => commitPendingWorkspaceRestore(target, staged.id)).toThrow(expect.objectContaining({ errorKey: "serverError.backup.legacyBursts",
      message: "This backup's burst records (bursts.db) are damaged, so nothing was restored and nothing here changed. Make a new backup where it came from." }));
    expect(applyPendingWorkspaceRestore(target)).toEqual({ restored: false });
    expect(readFileSync(join(target, "notes.md"), "utf8")).toBe("here");
  }, TIMEOUT_MS);
});
