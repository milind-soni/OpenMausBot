import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { backupFolder, context, dataFolder, manifest, NOW } from "../../testing/doctor-folders.ts";
import { runDoctor } from "../run.ts";
import { messagesDbCheck } from "./messages-db.ts";

/** Every row in one transaction: a commit per row is a flush to disk per row, about 12 ms each on a Windows runner in
 * WAL mode and about 100 ms in the default rollback-journal mode (which also creates and deletes messages.db-journal
 * each time). A test needs the rows, not hundreds of commits. */
function insertRows(db: DatabaseSync, rows: number, text: (n: number) => string): void {
  const insert = db.prepare("INSERT INTO messages VALUES (?, ?)");
  db.exec("BEGIN");
  for (let n = 0; n < rows; n += 1) insert.run(String(n), text(n));
  db.exec("COMMIT");
}

function database(data: string, rows = 10): DatabaseSync {
  const db = new DatabaseSync(join(data, "messages.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE messages (id TEXT, text TEXT)");
  insertRows(db, rows, () => "x".repeat(2000));
  return db;
}

describe("messages-db check", () => {
  it("finds a sound database fine, and a missing one", () => {
    const data = dataFolder();
    expect(messagesDbCheck().check(context(data)).status).toBe("ok");
    database(data).close();
    expect(messagesDbCheck().check(context(data))).toMatchObject({ status: "ok", summary: "SQLite finds it sound." });
  });

  it("reports a damaged database with what to do, and never fixes it", () => {
    const data = dataFolder();
    writeFileSync(join(data, "messages.db"), Buffer.alloc(8192, 7));
    const report = runDoctor({ dataDir: data, version: "9.9.9", mode: "start", fix: true, now: () => NOW, checks: [messagesDbCheck()] });
    expect(report.checks[0]).toMatchObject({ status: "problem", fixable: false });
    expect(report.checks[0]!.instruction).toContain("does not rewrite it");
    expect(backupFolder(data)).toBeNull();
  });

  it("folds a large write-ahead log back after copying the database and the log", () => {
    const data = dataFolder();
    const writer = database(data, 200);
    try {
      const wal = statSync(join(data, "messages.db-wal")).size;
      expect(wal).toBeGreaterThan(100_000);
      const check = messagesDbCheck({ largeWalBytes: 100_000, freeBytes: () => null });
      expect(check.check(context(data))).toMatchObject({ status: "problem", fixable: true });
      const report = runDoctor({ dataDir: data, version: "9.9.9", mode: "start", fix: true, now: () => NOW, checks: [check] });
      expect(report.checks[0]).toMatchObject({ status: "fixed", fixed: "Folded the write-ahead log back into the database." });
      expect(statSync(join(data, "messages.db-wal")).size).toBe(0);
      const backup = backupFolder(data)!;
      expect(statSync(join(backup, "messages.db-wal")).size).toBe(wal);
      expect(manifest(backup).entries.map((entry) => entry.path)).toContain(join(data, "messages.db"));
      expect((writer.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n).toBe(200);
    } finally {
      writer.close();
    }
  });

  it("does not copy into a disk without room for it", () => {
    const data = dataFolder();
    const writer = database(data, 200);
    try {
      const finding = messagesDbCheck({ largeWalBytes: 100_000, freeBytes: () => 1024 }).check(context(data));
      expect(finding).toMatchObject({ status: "problem", fixable: false });
      expect(finding.instruction).toContain("free some disk");
    } finally {
      writer.close();
    }
  });

  it("skips the full read of a large database at start, and not on the command", () => {
    const data = dataFolder();
    writeFileSync(join(data, "messages.db"), Buffer.alloc(8192, 7));
    const check = messagesDbCheck({ startCheckMaxBytes: 1024 });
    expect(check.check(context(data, { mode: "start" })).status).toBe("ok");
    expect(check.check(context(data, { mode: "command" })).status).toBe("problem");
    expect(existsSync(join(data, "messages.db-wal"))).toBe(false);
  });

  it("reports what SQLite's own check finds damaged inside a database it can open", () => {
    const data = dataFolder();
    const db = new DatabaseSync(join(data, "messages.db"));
    db.exec("CREATE TABLE messages (id TEXT, text TEXT); CREATE INDEX by_text ON messages (text)");
    insertRows(db, 500, (n) => `${"y".repeat(200)}${n}`);
    db.close();
    // Overwrite part of a page in the middle: the header still reads, the tree does not.
    const bytes = readFileSync(join(data, "messages.db"));
    bytes.fill(0x41, 4096 * 3, 4096 * 3 + 2000);
    writeFileSync(join(data, "messages.db"), bytes);
    const finding = messagesDbCheck({ busyTimeoutMs: 0 }).check(context(data));
    expect(finding).toMatchObject({ status: "problem", summary: expect.stringMatching(/^SQLite finds the database damaged: \d+ problems? /) });
    expect(finding.instruction).toContain("./update.sh --rollback");
  });

  it("takes a database it cannot open for not checked, never for damaged, and points at no restore", () => {
    const data = dataFolder();
    // A folder where the file goes: it cannot be opened on any platform.
    mkdirSync(join(data, "messages.db"));
    const report = runDoctor({ dataDir: data, version: "9.9.9", mode: "start", fix: true, now: () => NOW, checks: [messagesDbCheck({ busyTimeoutMs: 0 })] });
    expect(report.checks[0]).toMatchObject({ status: "problem", fixable: false, summary: expect.stringMatching(/^Could not check messages\.db: /) });
    expect(report.checks[0]!.instruction).not.toContain("rollback");
    expect(report.checks[0]!.instruction).not.toContain("put back");
    expect(backupFolder(data)).toBeNull();
  });

  it("takes a database another program has locked for not checked, not damaged", () => {
    const data = dataFolder();
    const holder = new DatabaseSync(join(data, "messages.db"));
    try {
      holder.exec("CREATE TABLE messages (id TEXT); INSERT INTO messages VALUES ('1'); BEGIN EXCLUSIVE; INSERT INTO messages VALUES ('2')");
      const finding = messagesDbCheck({ busyTimeoutMs: 0 }).check(context(data));
      expect(finding).toMatchObject({ status: "problem", summary: "Could not check messages.db: database is locked." });
      expect(finding.instruction).not.toContain("rollback");
    } finally {
      holder.close();
    }
    expect(messagesDbCheck({ busyTimeoutMs: 0 }).check(context(data))).toMatchObject({ status: "ok", summary: "SQLite finds it sound." });
  });

  it.skipIf(process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0))("takes a database this user may not read for not checked", () => {
    const data = dataFolder();
    database(data).close();
    chmodSync(join(data, "messages.db"), 0o000);
    try {
      const finding = messagesDbCheck({ busyTimeoutMs: 0 }).check(context(data));
      expect(finding).toMatchObject({ status: "problem", summary: expect.stringMatching(/^Could not check messages\.db: /) });
      expect(finding.instruction).not.toContain("rollback");
    } finally {
      chmodSync(join(data, "messages.db"), 0o600);
    }
  });

  it("does not count a checkpoint another connection keeps from finishing as a repair", () => {
    const data = dataFolder();
    const writer = database(data, 200);
    const reader = new DatabaseSync(join(data, "messages.db"));
    try {
      // An open read transaction: the log cannot be emptied under it.
      reader.exec("BEGIN");
      reader.prepare("SELECT count(*) FROM messages").get();
      const check = messagesDbCheck({ largeWalBytes: 100_000, freeBytes: () => null, busyTimeoutMs: 0 });
      const report = runDoctor({ dataDir: data, version: "9.9.9", mode: "start", fix: true, now: () => NOW, checks: [check] });
      expect(report.checks[0]).toMatchObject({ status: "failed" });
      expect(report.checks[0]!.repaired).toBeFalsy();
      expect(report.counts.fixed).toBe(0);
      expect(statSync(join(data, "messages.db-wal")).size).toBeGreaterThan(100_000);
      // What it was about to change was copied first.
      expect(existsSync(join(backupFolder(data)!, "messages.db-wal"))).toBe(true);
    } finally {
      reader.close();
      writer.close();
    }
  });

  it("runs SQLite's check only in the first look; a look again takes the first look's verdict", () => {
    const data = dataFolder();
    writeFileSync(join(data, "messages.db"), Buffer.alloc(8192, 7));
    const check = messagesDbCheck({ busyTimeoutMs: 0 });
    const first = check.check(context(data));
    expect(first.summary).toMatch(/^SQLite finds the database damaged/);
    const sound = check.check(context(data, { earlier: { status: "ok", summary: "", detail: { verdict: { kind: "ok" } } } }));
    expect(sound).toMatchObject({ status: "ok", summary: "SQLite finds it sound." });
  });

  it("counts the log with the database against the size read at start", () => {
    const data = dataFolder();
    const writer = database(data, 200);
    try {
      const dbBytes = statSync(join(data, "messages.db")).size;
      const check = messagesDbCheck({ startCheckMaxBytes: dbBytes + 1024, largeWalBytes: 100_000, freeBytes: () => null, busyTimeoutMs: 0 });
      const finding = check.check(context(data, { mode: "start" }));
      expect(finding).toMatchObject({ status: "problem", fixable: false, summary: expect.stringContaining("checked only by openmausbot doctor --data") });
      expect(check.check(context(data, { mode: "command" }))).toMatchObject({ fixable: true, summary: expect.stringMatching(/^SQLite finds it sound; /) });
    } finally {
      writer.close();
    }
  });
});
