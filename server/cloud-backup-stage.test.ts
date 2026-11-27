// A Cloud server's backup of its volume packs consistent copies of the databases (cloud-backup-stage.ts): one moment of each,
// taken while the server goes on writing, never more than the disk can hold, and only as the data folder's owner.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { BACKUP_STAGE, prepareBackupStage, stageReserve } from "./cloud-backup-stage.ts";

const GB = 1024 ** 3;
const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
const directory = () => { const path = mkdtempSync(join(tmpdir(), "omb-backup-stage-")); scratch.push(path); return path; };
const roomy = () => ({ free: 100 * GB, total: 200 * GB });
const posix = process.platform !== "win32";

/** A database the server keeps: WAL mode, rows `id` 1.. in a table `m`. */
function database(path: string, rows: number) {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA journal_mode = WAL; CREATE TABLE m (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO m (id, body) VALUES (?, ?)");
    db.exec("BEGIN"); for (let id = 1; id <= rows; id++) insert.run(id, "x".repeat(500)); db.exec("COMMIT");
  } finally { db.close(); }
}
/** What a restore of the archive gives the server: the copy alone under the live name, its integrity, and its rows. */
function restored(copy: string) {
  const into = directory();
  copyFileSync(copy, join(into, "messages.db"));
  const db = new DatabaseSync(join(into, "messages.db"), { readOnly: true });
  try {
    const check = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    const rows = db.prepare("SELECT count(*) AS count, coalesce(max(id), 0) AS top FROM m").get() as { count: number; top: number };
    const mode = (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
    return { check: check.integrity_check, count: Number(rows.count), top: Number(rows.top), mode };
  } finally { db.close(); }
}

// The writer says how many rows it has committed on its output, one number a line. (It used to rename a progress file over
// the one the test was reading, which Windows refuses while the file is open: EPERM, and the writer died.)
const WRITER = `import { DatabaseSync } from "node:sqlite";
const [file] = process.argv.slice(2);
const db = new DatabaseSync(file);
db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA wal_autocheckpoint = 16; CREATE TABLE IF NOT EXISTS m (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
const insert = db.prepare("INSERT INTO m (id, body) VALUES (?, ?)"), body = "x".repeat(4000);
let n = 0, stop = false;
process.on("SIGTERM", () => { stop = true; });
const tick = () => {
  if (stop) { db.close(); process.exit(0); }
  db.exec("BEGIN"); for (let i = 0; i < 25; i++) insert.run(++n, body); db.exec("COMMIT");
  process.stdout.write(n + "\\n");
  setImmediate(tick);
};
tick();
`;

describe("prepareBackupStage", () => {
  it("copies one moment of messages.db while another process commits and checkpoints: it restores whole, with every row committed before it began", async () => {
    const data = directory(), work = directory();
    writeFileSync(join(work, "writer.mjs"), WRITER);
    const live = join(data, "messages.db");
    const child = spawn(process.execPath, [join(work, "writer.mjs"), live], { stdio: ["ignore", "pipe", "inherit"] });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    let said = 0, partial = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      const lines = (partial + chunk.toString("utf8")).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) if (/^\d+$/.test(line)) said = Number(line);
    });
    const committed = () => said;
    try {
      for (const until = Date.now() + 60_000; committed() < 3_000;) {
        if (Date.now() > until || child.exitCode !== null) throw new Error("the writer never got going");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const before = committed();
      const lines: string[] = [];
      const done = await prepareBackupStage({ dataDir: data, disk: roomy, log: (line) => lines.push(line) });
      expect(done).toMatchObject({ staged: ["messages.db"], skipped: [] });
      expect(lines).toEqual([]);
      // The writer went on: the copy was of a live database, not one at rest.
      for (const until = Date.now() + 60_000; committed() <= before && Date.now() < until;) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(committed()).toBeGreaterThan(before);
      expect(readdirSync(done.stage)).toEqual(["messages.db"]);
      child.kill("SIGTERM"); await exited;
      const reader = new DatabaseSync(live, { readOnly: true });
      const top = Number((reader.prepare("SELECT max(id) AS top FROM m").get() as { top: number }).top);
      reader.close();
      const got = restored(join(done.stage, "messages.db"));
      expect(got.check).toBe("ok");
      expect(got.mode).toBe("delete");
      expect(got.count).toBe(got.top);
      expect(got.top).toBeGreaterThanOrEqual(before);
      expect(got.top).toBeLessThanOrEqual(top);
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await exited; }
    }
  }, 120_000);

  it("stages each database there is, under its own name, keeps its mode, and leaves nothing of an earlier run", async () => {
    const data = directory();
    database(join(data, "messages.db"), 50);
    database(join(data, "runtime.db"), 5);
    mkdirSync(join(data, BACKUP_STAGE));
    writeFileSync(join(data, BACKUP_STAGE, "bursts.db"), "stale, from a backup that was killed");
    writeFileSync(join(data, BACKUP_STAGE, "messages.db.partial"), "half");
    const done = await prepareBackupStage({ dataDir: data, disk: roomy, log: () => {} });
    expect(done.staged).toEqual(["messages.db", "runtime.db"]);
    expect(readdirSync(done.stage).sort()).toEqual(["messages.db", "runtime.db"]);
    expect(restored(join(done.stage, "messages.db"))).toMatchObject({ check: "ok", count: 50, top: 50 });
    if (posix) {
      expect(lstatSync(done.stage).mode & 0o777).toBe(0o700);
      expect(lstatSync(join(done.stage, "messages.db")).mode & 0o777).toBe(lstatSync(join(data, "messages.db")).mode & 0o777);
    }
  });

  it("skips a database the disk has no room to copy (leaving the reserve free), says so, and leaves no partial copy", async () => {
    const data = directory();
    database(join(data, "messages.db"), 200);
    database(join(data, "runtime.db"), 2);
    const messages = lstatSync(join(data, "messages.db")).size;
    // A 10 GB disk: the reserve is 1 GB. Room for the small database, not for the large one after the reserve.
    const total = 10 * GB, free = stageReserve(total) + messages - 1;
    const lines: string[] = [];
    const done = await prepareBackupStage({ dataDir: data, disk: () => ({ free, total }), log: (line) => lines.push(line) });
    expect(done.staged).toEqual(["runtime.db"]);
    expect(done.skipped.map((item) => item.name)).toEqual(["messages.db"]);
    expect(lines).toEqual([expect.stringMatching(/^omb backup: messages\.db not snapshotted \(.+ free, the copy needs up to .+ and must leave 1\.0 GB\); the backup packs its live files$/)]);
    expect(readdirSync(done.stage)).toEqual(["runtime.db"]);
    expect(stageReserve(200 * GB)).toBe(10 * GB);
  });

  it("skips a database it cannot copy, removing what it began, and still stages the others", async () => {
    const data = directory();
    writeFileSync(join(data, "messages.db"), "not a database at all, but long enough to be read as a header ".repeat(4));
    database(join(data, "runtime.db"), 3);
    const lines: string[] = [];
    const done = await prepareBackupStage({ dataDir: data, disk: roomy, log: (line) => lines.push(line) });
    expect(done.staged).toEqual(["runtime.db"]);
    expect(done.skipped.map((item) => item.name)).toEqual(["messages.db"]);
    expect(readdirSync(done.stage)).toEqual(["runtime.db"]);
    expect(lines).toHaveLength(1);
  });

  it.skipIf(!posix)("never follows a database that is a link", async () => {
    const data = directory(), elsewhere = directory();
    database(join(elsewhere, "messages.db"), 3);
    symlinkSync(join(elsewhere, "messages.db"), join(data, "messages.db"));
    const done = await prepareBackupStage({ dataDir: data, disk: roomy, log: () => {} });
    expect(done.staged).toEqual([]);
    expect(done.skipped).toEqual([{ name: "messages.db", why: "not a plain file" }]);
  });

  it.skipIf(!posix)("runs only as the data folder's owner, so no copy is ever root's", async () => {
    const data = directory();
    database(join(data, "messages.db"), 3);
    const owner = lstatSync(data).uid;
    await expect(prepareBackupStage({ dataDir: data, disk: roomy, log: () => {}, uid: owner + 1 })).rejects.toThrow(/only as the data folder's owner/);
    expect(existsSync(join(data, BACKUP_STAGE))).toBe(false);
  });
});

describe("the command a Cloud server's backup runs", () => {
  const entry = fileURLToPath(new URL("./cloud-backup-db-snapshot.ts", import.meta.url));
  it("stages the data folder OMB_DATA_DIR names and prints what it staged; with none named, exits 2", () => {
    const data = directory();
    database(join(data, "messages.db"), 7);
    const ran = spawnSync(process.execPath, [entry], { encoding: "utf8", env: { ...process.env, OMB_DATA_DIR: data } });
    expect(ran.status, ran.stderr).toBe(0);
    expect(ran.stdout.trim()).toBe("messages.db");
    expect(restored(join(data, BACKUP_STAGE, "messages.db"))).toMatchObject({ check: "ok", count: 7 });
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.OMB_DATA_DIR;
    const unnamed = spawnSync(process.execPath, [entry], { encoding: "utf8", env });
    expect(unnamed.status).toBe(2);
  });
});
