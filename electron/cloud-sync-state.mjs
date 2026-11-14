// The desktop's record for Sync with My Cloud, one SQLite file in user data: each folder's base (every file as it was
// when last in step on both sides), where each bot output folder landed on this PC, per-file failures, and flags.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openSyncState(file) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS base(folder TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, mtime REAL NOT NULL, PRIMARY KEY(folder, path));
    CREATE TABLE IF NOT EXISTS places(folder TEXT PRIMARY KEY, local TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS failures(folder TEXT NOT NULL, path TEXT NOT NULL, count INTEGER NOT NULL, error TEXT NOT NULL, PRIMARY KEY(folder, path));
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  return {
    base(folder) {
      return new Map(db.prepare("SELECT path, sha256, size, mtime FROM base WHERE folder = ?").all(folder).map((row) => [row.path, { sha256: row.sha256, size: row.size, mtimeMs: row.mtime }]));
    },
    setBase(folder, path, row) { db.prepare("INSERT OR REPLACE INTO base VALUES (?, ?, ?, ?, ?)").run(folder, path, row.sha256, row.size, row.mtimeMs); },
    dropBase(folder, path) { db.prepare("DELETE FROM base WHERE folder = ? AND path = ?").run(folder, path); },
    dropFolder(folder) { db.prepare("DELETE FROM base WHERE folder = ?").run(folder); },
    place(folder) { return db.prepare("SELECT local FROM places WHERE folder = ?").get(folder)?.local ?? null; },
    setPlace(folder, local) { db.prepare("INSERT OR REPLACE INTO places VALUES (?, ?)").run(folder, local); },
    places() { return db.prepare("SELECT folder, local FROM places").all().map((row) => ({ folder: row.folder, local: row.local })); },
    failed(folder, path, error) {
      db.prepare("INSERT INTO failures VALUES (?, ?, 1, ?) ON CONFLICT(folder, path) DO UPDATE SET count = count + 1, error = excluded.error").run(folder, path, error);
      return db.prepare("SELECT count FROM failures WHERE folder = ? AND path = ?").get(folder, path).count;
    },
    cleared(folder, path) { db.prepare("DELETE FROM failures WHERE folder = ? AND path = ?").run(folder, path); },
    failures() { return db.prepare("SELECT folder, path, error FROM failures WHERE count >= 3 ORDER BY folder, path").all().map((row) => ({ folderId: row.folder, path: row.path, error: row.error })); },
    meta(key) { return db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null; },
    setMeta(key, value) { db.prepare("INSERT OR REPLACE INTO meta VALUES (?, ?)").run(key, value); },
    reset() { db.exec("DELETE FROM base; DELETE FROM places; DELETE FROM failures; DELETE FROM meta;"); },
    close() { db.close(); },
  };
}
