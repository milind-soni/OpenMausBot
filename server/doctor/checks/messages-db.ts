// messages.db: every conversation's messages. SQLite's own check says whether the file is sound; a damaged one is for a
// person (the doctor never rewrites it). A write-ahead log grown large while no server folds it back makes each start
// slower; folding it in (a checkpoint) is SQLite's own step, taken after both files are copied into the backup.
import { existsSync, statfsSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { DoctorCheck } from "../types.ts";

const DB = "messages.db";
/** Above this, the check and the copy before a checkpoint are not done at start: both read the whole file, and an update
 * waits on the start. `openmausbot doctor --data` does them at any size. */
export const START_CHECK_MAX_BYTES = 256 * 1024 * 1024;
/** A log this big is folded back into the database. */
export const LARGE_WAL_BYTES = 64 * 1024 * 1024;

const size = (path: string) => { try { return statSync(path).size; } catch { return 0; } };

export function messagesDbCheck(limits: { startCheckMaxBytes?: number; largeWalBytes?: number; freeBytes?: (dir: string) => number | null } = {}): DoctorCheck {
  const startMax = limits.startCheckMaxBytes ?? START_CHECK_MAX_BYTES, largeWal = limits.largeWalBytes ?? LARGE_WAL_BYTES;
  const freeBytes = limits.freeBytes ?? ((dir: string) => {
    try { const stats = statfsSync(dir); return Number(stats.bavail) * Number(stats.bsize); } catch { return null; }
  });
  return {
    id: "messages-db",
    title: "Messages database",
    looksAt: `${DB}, ${DB}-wal`,
    check(ctx) {
      const file = join(ctx.dataDir, DB);
      if (!existsSync(file)) return { status: "ok", summary: "Not there yet." };
      const dbBytes = size(file), walBytes = size(`${file}-wal`);
      const atStart = ctx.mode === "start";
      let verdict: string | null = null;
      if (!atStart || dbBytes <= startMax) {
        let db: DatabaseSync | null = null;
        try {
          db = new DatabaseSync(file, { readOnly: true });
          // SQLite's integrity check without the slow comparison of every index with its table.
          const rows = db.prepare("PRAGMA quick_check(20)").all() as Record<string, unknown>[];
          const lines = rows.map((row) => String(Object.values(row)[0]));
          verdict = lines.length === 1 && lines[0] === "ok" ? "ok" : `${lines.length} problem${lines.length === 1 ? "" : "s"} (first: ${lines[0]?.slice(0, 160) ?? "unknown"})`;
        } catch (error) {
          verdict = `it cannot be opened (${error instanceof Error ? error.message.slice(0, 160) : String(error)})`;
        } finally {
          try { db?.close(); } catch {}
        }
      }
      if (verdict && verdict !== "ok") {
        return { status: "problem", summary: `SQLite finds the database damaged: ${verdict}.`,
          instruction: "Stop the server and put back messages.db from the copy taken before the last update (./update.sh --rollback) or from a workspace backup. The doctor does not rewrite it." };
      }
      const checked = verdict === "ok" ? "SQLite finds it sound" : `${Math.round(dbBytes / 1024 / 1024)} MB: checked only by openmausbot doctor --data`;
      if (walBytes > largeWal) {
        const free = freeBytes(ctx.dataDir);
        const room = free === null || free > 2 * (dbBytes + walBytes);
        const now = !atStart || dbBytes + walBytes <= startMax;
        return { status: "problem", fixable: room && now, detail: { file },
          summary: `${checked}; its write-ahead log is ${Math.round(walBytes / 1024 / 1024)} MB.`,
          ...(!room ? { instruction: "There is not room to copy it first: free some disk, then run openmausbot doctor --data --fix." }
            : !now ? { instruction: "Too large to copy as the server starts: stop the server, then run openmausbot doctor --data --fix." } : {}) };
      }
      return { status: "ok", summary: `${checked}.` };
    },
    fix(_ctx, finding, backup) {
      const { file } = finding.detail as { file: string };
      backup.copy("messages-db", file);
      for (const extra of [`${file}-wal`, `${file}-shm`]) if (existsSync(extra)) backup.copy("messages-db", extra);
      const db = new DatabaseSync(file);
      try {
        const [row] = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").all() as { busy?: number }[];
        if (row?.busy) throw new Error("another connection holds the database");
      } finally {
        db.close();
      }
      return "Folded the write-ahead log back into the database.";
    },
  };
}
