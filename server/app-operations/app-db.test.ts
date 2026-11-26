// An app's own SQLite file through its database process: what SQLite itself refuses, and what the process kill stops.
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AppDatabase } from "./app-db.ts";
import type { AppMigration } from "./manifest.ts";

const MIGRATIONS: AppMigration[] = [
  { version: 1, name: "001_init.sql", sql: "CREATE TABLE issues (id INTEGER PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open');" },
  { version: 2, name: "002_priority.sql", sql: "ALTER TABLE issues ADD COLUMN priority INTEGER NOT NULL DEFAULT 2; CREATE INDEX issues_status ON issues(status);" },
];
const LIMITS = { rows: 100, bytes: 100_000, statementMs: 2_000 };
const open: AppDatabase[] = [];

function database(file = join(mkdtempSync(join(tmpdir(), "ao-db-")), "app.db"), migrations = MIGRATIONS, limits = LIMITS) {
  const db = new AppDatabase({ file, migrations, limits });
  open.push(db);
  return { db, file };
}

async function failure(work: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await work; } catch (error) { return { code: (error as { code: string }).code, message: (error as Error).message }; }
  throw new Error("expected a failure");
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.close()));
});

describe("app database", () => {
  it("applies migrations once, in order, across restarts", async () => {
    const { db, file } = database();
    await db.query("SELECT 1 AS one", undefined, "read");
    expect(db.stats.applied).toEqual([1, 2]);
    await db.close();
    const again = database(file).db;
    const columns = await again.query("SELECT name FROM pragma_table_info('issues')", undefined, "read").catch((error) => error);
    expect(again.stats.applied).toEqual([]);
    expect(String(columns.message ?? "")).toMatch(/not authorized/);
    const third = database(file, [...MIGRATIONS, { version: 3, name: "003_due.sql", sql: "ALTER TABLE issues ADD COLUMN due TEXT;" }]).db;
    await third.query("SELECT due FROM issues", undefined, "read");
    expect(third.stats.applied).toEqual([3]);
  });

  it("refuses an app older than its database", async () => {
    const { db, file } = database();
    await db.query("SELECT 1", undefined, "read");
    await db.close();
    const older = database(file, MIGRATIONS.slice(0, 1)).db;
    expect((await failure(older.query("SELECT 1", undefined, "read"))).code).toBe("migration_newer");
  });

  it("commits a change, and a change in progress is invisible to reads", async () => {
    const { db } = database();
    await db.begin();
    await db.exec("INSERT INTO issues (title) VALUES (?)", ["first"]);
    expect((await db.query("SELECT count(*) AS n FROM issues", undefined, "write")).rows).toEqual([{ n: 1 }]);
    expect((await db.query("SELECT count(*) AS n FROM issues", undefined, "read")).rows).toEqual([{ n: 0 }]);
    await db.commit();
    expect((await db.query("SELECT count(*) AS n FROM issues", undefined, "read")).rows).toEqual([{ n: 1 }]);
    await db.begin();
    await db.exec("INSERT INTO issues (title) VALUES (?)", ["second"]);
    await db.rollback();
    expect((await db.query("SELECT count(*) AS n FROM issues", undefined, "read")).rows).toEqual([{ n: 1 }]);
  });

  it("a read cannot write, whatever the SQL says", async () => {
    const { db } = database();
    for (const sql of [
      "INSERT INTO issues (title) VALUES ('x')",
      "UPDATE issues SET title = 'x'",
      "DELETE FROM issues",
      "CREATE TABLE evil (x)",
      "DROP TABLE issues",
      "WITH t AS (SELECT 1) INSERT INTO issues (title) SELECT 'x' FROM t",
    ]) {
      const refused = await failure(db.query(sql, undefined, "read"));
      expect(refused.message, sql).toMatch(/not authorized|readonly|read-only/i);
    }
    expect((await failure(db.exec("INSERT INTO issues (title) VALUES ('x')", undefined))).code).toBe("read_only");
  });

  it("SQLite refuses files, other databases, extensions and settings", async () => {
    const { db, file } = database();
    const outside = join(mkdtempSync(join(tmpdir(), "ao-out-")), "copy.db");
    await db.begin();
    for (const sql of [
      `ATTACH DATABASE '${outside}' AS other`,
      "SELECT load_extension('/tmp/x')",
      "PRAGMA journal_mode = DELETE",
      "PRAGMA writable_schema = ON",
      "SELECT * FROM pragma_database_list",
      "BEGIN",
      "COMMIT",
      "SAVEPOINT s1",
      "CREATE TABLE evil (x)",
      "CREATE TEMP TABLE evil (x)",
      "UPDATE sqlite_master SET sql = ''",
    ]) {
      const refused = await failure(db.exec(sql, undefined));
      expect(refused.message, sql).toMatch(/not authorized|too many attached|may not be modified/i);
    }
    for (const sql of ["SELECT readfile('/etc/hosts')", "SELECT writefile('/tmp/x', 'y')", "SELECT edit('x')"]) {
      expect((await failure(db.query(sql, undefined, "write"))).message, sql).toMatch(/no such function/);
    }
    await db.rollback();
    for (const sql of [`VACUUM INTO '${outside}'`, "VACUUM", `ATTACH DATABASE '${outside}' AS other`]) {
      expect((await failure(db.query(sql, undefined, "read"))).message, sql).toMatch(/not authorized|authorization denied|too many attached/i);
    }
    expect(existsSync(outside)).toBe(false);
    expect(file).toMatch(/app\.db$/);
  });

  it("stops a statement past its time by killing the database process, and rolls the change back", async () => {
    const { db } = database(undefined, MIGRATIONS, { ...LIMITS, statementMs: 1_000 });
    await db.begin();
    await db.exec("INSERT INTO issues (title) SELECT 'row ' || value FROM generate_series(1, 2000)", undefined).catch(async () => {
      await db.exec("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 2000) INSERT INTO issues (title) SELECT 'row ' || x FROM c", undefined);
    });
    const pid = db.pid;
    const started = performance.now();
    const refused = await failure(db.query("SELECT count(*) FROM issues a, issues b, issues c", undefined, "write"));
    const took = performance.now() - started;
    expect(refused.code).toBe("statement_timeout");
    expect(took).toBeGreaterThanOrEqual(990);
    expect(took).toBeLessThan(3_000);
    expect(db.stats.killed).toBe(1);
    await db.lastExit;
    expect(() => process.kill(pid!, 0)).toThrow();
    expect((await db.query("SELECT count(*) AS n FROM issues", undefined, "read")).rows).toEqual([{ n: 0 }]);
    expect(db.stats.starts).toBe(2);
  });

  it("caps rows and bytes per result", async () => {
    const { db } = database(undefined, MIGRATIONS, { rows: 10, bytes: 400, statementMs: 2_000 });
    const many = await db.query("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 50) SELECT x FROM c", undefined, "read");
    expect(many.rows).toHaveLength(10);
    expect(many.truncated).toBe(true);
    const wide = await db.query("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 5) SELECT x, printf('%.100c', 'a') AS pad FROM c", undefined, "read");
    expect(wide.rows.length).toBeLessThan(5);
    expect(wide.truncated).toBe(true);
  });
});
