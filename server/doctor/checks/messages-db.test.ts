import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { backupFolder, context, dataFolder, manifest, NOW } from "../../testing/doctor-folders.ts";
import { runDoctor } from "../run.ts";
import { messagesDbCheck } from "./messages-db.ts";

function database(data: string, rows = 10): DatabaseSync {
  const db = new DatabaseSync(join(data, "messages.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE messages (id TEXT, text TEXT)");
  const insert = db.prepare("INSERT INTO messages VALUES (?, ?)");
  for (let n = 0; n < rows; n += 1) insert.run(String(n), "x".repeat(2000));
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
});
