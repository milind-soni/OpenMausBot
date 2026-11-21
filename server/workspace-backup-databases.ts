// The databases in the data folder a full backup carries, and how each is taken whole. A database the server keeps in
// WAL mode holds its newest rows in the -wal file beside it, and a copy of the two taken one after the other while a
// writer goes on is not one database: each is taken instead by SQLite's own snapshot, which reads one moment of it.
// Each bot's Data tables (bots/<id>/data.duckdb) are copied as files once the Data engine has let go of them, which
// writes its WAL into the file: the maintenance gate does that (releaseDataForBackup) and keeps them shut until the
// backup ends.
// Not carried: sync/index.db (Sync with My Cloud's own records, the whole sync folder is this machine's), the engines'
// own databases (in their login homes, which never go), and DuckDB's spill folder (data-tmp), emptied when it closes.
import { existsSync, lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import type { DataEngine } from "./data/types.ts";

/** Each database the server keeps in WAL mode at the data folder's top, and the name of its snapshot. */
export const SNAPSHOT_DATABASES: Record<string, string> = { "messages.db": "messages-snapshot.db", "runtime.db": "runtime-snapshot.db", "bursts.db": "bursts-snapshot.db" };
const LABELS: Record<string, string> = { "messages.db": "message", "runtime.db": "runtime", "bursts.db": "burst" };

/** The live WAL and shared-memory files of the snapshotted databases. */
export const LIVE_DATABASE_SIDECARS = new Set(Object.keys(SNAPSHOT_DATABASES).flatMap((name) => [`${name}-wal`, `${name}-shm`]));

/** Sidecars a backup leaves out, which older backups carried raw beside their database: they still restore, folded into it. */
export const LEGACY_SIDECARS = new Set(["bursts.db-wal", "bursts.db-shm"]);

/** One moment of each database, as `snapshot/<snapshot name>` in DELETE mode: never the live file and its log. */
export async function snapshotDatabases(root: string, snapshot: string): Promise<void> {
  for (const [name, snapshotName] of Object.entries(SNAPSHOT_DATABASES)) {
    const sourceDb = join(root, name);
    if (!existsSync(sourceDb)) continue;
    if (lstatSync(sourceDb).isSymbolicLink()) throw new Error(`The ${LABELS[name]} database must not be a symbolic link.`);
    // Another connection may open this database meanwhile; without a busy timeout the backup fails at once ("database is locked").
    const db = new DatabaseSync(sourceDb, { readOnly: true, timeout: 5_000 });
    // Node 26's native backup completion can wait on unrelated event-loop activity after an async scrypt; this pulse keeps it moving.
    const completionPulse = setInterval(() => {}, 25);
    try { await backup(db, join(snapshot, snapshotName)); }
    finally { clearInterval(completionPulse); db.close(); }
    const snapshotDb = new DatabaseSync(join(snapshot, snapshotName));
    try { snapshotDb.exec("PRAGMA journal_mode = DELETE"); } finally { snapshotDb.close(); }
  }
}

/** An older backup's raw WAL goes into its database before the restore installs it, so the restored folder holds one
 * file per database as a new backup does. SQLite applies what of the log matches the database, as it would have on open. */
export function foldLegacySidecars(prepared: string): void {
  for (const name of Object.keys(SNAPSHOT_DATABASES)) {
    const wal = join(prepared, `${name}-wal`);
    const shm = join(prepared, `${name}-shm`);
    if (!LEGACY_SIDECARS.has(`${name}-wal`) || (!existsSync(wal) && !existsSync(shm))) continue;
    // The shared-memory index is the source server's; SQLite rebuilds it from the log.
    rmSync(shm, { force: true });
    if (existsSync(join(prepared, name)) && existsSync(wal)) {
      const db = new DatabaseSync(join(prepared, name));
      try { db.exec("PRAGMA journal_mode = DELETE"); } finally { db.close(); }
    }
    rmSync(wal, { force: true });
  }
}

/** The gate's last step before a backup or restore: every bot's Data tables written into their files and let go. A
 * statement that did not stop still holds one, and a copy of it now could miss what it wrote, so the backup waits. */
export async function releaseDataForBackup(engine: Pick<DataEngine, "release">): Promise<void> {
  if ((await engine.release()).length) throw Object.assign(new Error("The workspace is still finishing background work. Try again shortly."), { status: 409 });
}
