// Another browser's SQLite database, read from a private copy.
//
// Adapted from anomalyco/opencode@5ca87b9 packages/gui-plugins/src/browser/profile/database.ts (snapshotDatabase,
// sweepSnapshots), MIT License, Copyright (c) 2025 opencode (full text in third_party/opencode/LICENSE). Modified: one
// scratch folder of the app's own, swept of every leftover before each copy.
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const PREFIX = "copy-";

/**
 * A copy, with its write-ahead log, so the running browser keeps its lock and its file is never written. Chromium on
 * Windows holds the database open without sharing while it runs (EBUSY), and SQLite reads a live write-ahead log only
 * through its shared-memory file, which it would write. Security: the copy holds every value, so it lives in a 0700
 * folder of the app's own and is deleted before this returns; copies a crash left behind go before the next one.
 */
export async function readCopy<T>(file: string, scratch: string, read: (db: DatabaseSync) => T): Promise<T> {
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  await sweep(scratch);
  const directory = join(scratch, `${PREFIX}${randomUUID()}`);
  try {
    await mkdir(directory, { mode: 0o700 });
    const copy = join(directory, basename(file));
    await copyFile(file, copy);
    // A sidecar that does not exist is normal: the browser checkpointed or uses another journal mode.
    await Promise.all(["-wal", "-shm", "-journal"].map((suffix) => copyFile(`${file}${suffix}`, `${copy}${suffix}`).catch(() => undefined)));
    const db = new DatabaseSync(copy, { readOnly: false });
    try {
      return read(db);
    } finally {
      db.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 }).catch(() => undefined);
  }
}

/** Every copy left in the scratch folder: only one import reads at a time. */
export async function sweep(scratch: string): Promise<void> {
  const entries = await readdir(scratch).catch(() => [] as string[]);
  await Promise.all(entries.filter((entry) => entry.startsWith(PREFIX)).map((entry) => rm(join(scratch, entry), { recursive: true, force: true }).catch(() => undefined)));
}
