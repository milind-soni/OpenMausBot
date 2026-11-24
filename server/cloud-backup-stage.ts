// Consistent databases for a Cloud server's own backup of its volume (its boot script, behind a switch on the Cloud's
// control side, off by default). That backup is a tar of the whole volume while the home runs, and a tar reads
// messages.db and its -wal at different moments: a checkpoint between the two reads leaves an archive that restores a
// database missing pages, or a corrupt one. So, just before the tar, the server's backup runs
// `docker exec -u maus omb-home timeout 1800 node /app/dist-server/cloud-backup-db-snapshot.js`, which writes one moment of
// each database (snapshotDatabase: SQLite's backup API in one step; writers go on meanwhile) into <data>/backup-stage/<name>.
// The tar packs each copy under its live name and leaves out the live file, its -wal and -shm; it removes the stage after.
//
// The contract with that script: only finished copies are left in the stage, each under its database's own name (a copy is
// written as <name>.partial and renamed when done); the stage holds nothing from an earlier run; and a database the disk has
// no room to copy is left out (its live files are packed, as before), never filling the disk. It runs as the data folder's
// owner only, so every copy is the server's own, as the live file is.
// Not covered: each bot's Data tables (DuckDB, bots/<id>/data.duckdb), which the server closes after 10 idle minutes and only
// it can let go of (releaseDataForBackup); sync/index.db (a rebuildable cache); the engines' and browsers' own databases.
import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync, statfsSync } from "node:fs";
import { join } from "node:path";

import { renameWithRetry } from "./atomic.ts";
import { SNAPSHOT_DATABASES, snapshotDatabase } from "./workspace-backup-databases.ts";

/** The stage's folder in the data folder (the boot script reads it at /mnt/omb-data/.openmausbot/backup-stage). */
export const BACKUP_STAGE = "backup-stage";
const GB = 1024 ** 3;
/** Room a copy must leave free on the disk: the larger of 1 GB and 5% of it. The live WAL grows meanwhile (no checkpoint
 * passes the copy's read), and the server keeps writing; this is what they get. */
export const stageReserve = (total: number) => Math.max(GB, Math.ceil(total * 0.05));

export interface StageDisk { free: number; total: number }
export interface PrepareBackupStage {
  dataDir: string;
  /** The disk under the data folder now (statfs): bytes free to this user, and its size. */
  disk?: (path: string) => StageDisk;
  log?: (line: string) => void;
  /** This process's user id (null where there is none, as on Windows). */
  uid?: number | null;
}
export interface PreparedBackupStage { stage: string; staged: string[]; skipped: { name: string; why: string }[] }

const statDisk = (path: string): StageDisk => {
  const disk = statfsSync(path);
  return { free: disk.bavail * disk.bsize, total: disk.blocks * disk.bsize };
};
const size = (path: string) => (existsSync(path) ? lstatSync(path).size : 0);
const gb = (bytes: number) => `${(bytes / GB).toFixed(1)} GB`;

export async function prepareBackupStage(options: PrepareBackupStage): Promise<PreparedBackupStage> {
  const { dataDir } = options;
  const log = options.log ?? ((line: string) => console.error(line));
  const disk = options.disk ?? statDisk;
  const uid = options.uid === undefined ? (process.getuid?.() ?? null) : options.uid;
  const folder = lstatSync(dataDir);
  if (!folder.isDirectory()) throw new Error(`The data folder ${dataDir} is not a folder.`);
  // As root (docker exec without -u), the copies would be root's and the server could not open them after a restore.
  if (uid !== null && uid !== folder.uid) throw new Error(`Runs only as the data folder's owner (uid ${folder.uid}), not uid ${uid}.`);
  const stage = join(dataDir, BACKUP_STAGE);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { mode: 0o700 });
  const staged: string[] = [], skipped: { name: string; why: string }[] = [];
  const skip = (name: string, why: string) => { skipped.push({ name, why }); log(`omb backup: ${name} not snapshotted (${why}); the backup packs its live files`); };
  for (const name of Object.keys(SNAPSHOT_DATABASES)) {
    const source = join(dataDir, name);
    if (!existsSync(source)) continue;
    const live = lstatSync(source);
    if (!live.isFile()) { skip(name, "not a plain file"); continue; }
    // The copy is at most the database and its log; it must leave the reserve free.
    const need = live.size + size(`${source}-wal`);
    const { free, total } = disk(dataDir);
    if (free - need < stageReserve(total)) { skip(name, `${gb(free)} free, the copy needs up to ${gb(need)} and must leave ${gb(stageReserve(total))}`); continue; }
    const partial = join(stage, `${name}.partial`);
    try {
      await snapshotDatabase(dataDir, name, partial);
      chmodSync(partial, live.mode & 0o777);
      // Windows refuses a rename while anything (a scanner) holds the new file: retried briefly, as every atomic write is.
      renameWithRetry(partial, join(stage, name));
      staged.push(name);
    } catch (error) {
      for (const path of [partial, `${partial}-journal`]) rmSync(path, { force: true });
      skip(name, error instanceof Error ? error.message : String(error));
    }
  }
  return { stage, staged, skipped };
}
