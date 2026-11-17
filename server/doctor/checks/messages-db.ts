// messages.db: every conversation's messages. SQLite's own check says whether the file is sound; a damaged one is for a
// person (the doctor never rewrites it). A write-ahead log grown large while no server folds it back makes each start
// slower; folding it in (a checkpoint) is SQLite's own step, taken after both files are copied into the backup. A file
// that cannot be opened or is locked is reported as not checked, never as damaged: only SQLite's own verdict on what it
// read is.
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

/** SQLite's own answer, from the first look: sound, damaged, or not looked at because the file could not be opened or
 * read (permissions, another program's lock), which says nothing about the file. Null: too large to read at start. */
type Verdict = { kind: "ok" } | { kind: "damaged"; text: string } | { kind: "unchecked"; reason: string } | null;

/** The result codes that mean the file itself is damaged: SQLITE_CORRUPT and SQLITE_NOTADB. */
const DAMAGED_CODES = new Set([11, 26]);

function quickCheck(file: string, busyTimeoutMs: number): Verdict {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true, timeout: busyTimeoutMs });
    // SQLite's integrity check without the slow comparison of every index with its table.
    const rows = db.prepare("PRAGMA quick_check(20)").all() as Record<string, unknown>[];
    const lines = rows.map((row) => String(Object.values(row)[0]));
    return lines.length === 1 && lines[0] === "ok" ? { kind: "ok" }
      : { kind: "damaged", text: `${lines.length} problem${lines.length === 1 ? "" : "s"} (first: ${lines[0]?.slice(0, 160) ?? "unknown"})` };
  } catch (error) {
    const code = (error as { errcode?: unknown }).errcode;
    const text = error instanceof Error ? error.message.slice(0, 160) : String(error);
    return typeof code === "number" && DAMAGED_CODES.has(code & 0xff) ? { kind: "damaged", text } : { kind: "unchecked", reason: text };
  } finally {
    try { db?.close(); } catch {}
  }
}

export function messagesDbCheck(limits: { startCheckMaxBytes?: number; largeWalBytes?: number; freeBytes?: (dir: string) => number | null; busyTimeoutMs?: number } = {}): DoctorCheck {
  const startMax = limits.startCheckMaxBytes ?? START_CHECK_MAX_BYTES, largeWal = limits.largeWalBytes ?? LARGE_WAL_BYTES;
  const busyTimeoutMs = limits.busyTimeoutMs ?? 5000;
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
      // The check reads the log as well as the database.
      const readable = ctx.mode !== "start" || dbBytes + walBytes <= startMax;
      // SQLite's check runs in the first look only: a look again before or after a fix goes by the sizes.
      const verdict: Verdict = ctx.earlier
        ? (ctx.earlier.detail as { verdict?: Verdict } | undefined)?.verdict ?? null
        : readable ? quickCheck(file, busyTimeoutMs) : null;
      if (verdict?.kind === "damaged") {
        return { status: "problem", summary: `SQLite finds the database damaged: ${verdict.text}.`, detail: { verdict },
          instruction: "Stop the server and put back messages.db from the copy taken before the last update (./update.sh --rollback) or from a workspace backup. The doctor does not rewrite it." };
      }
      if (verdict?.kind === "unchecked") {
        return { status: "problem", summary: `Could not check messages.db: ${verdict.reason}.`, detail: { verdict },
          instruction: "Make sure the server's user can read messages.db and no other program holds it, then run openmausbot doctor --data again." };
      }
      const checked = verdict ? "SQLite finds it sound" : `${Math.round((dbBytes + walBytes) / 1024 / 1024)} MB with its log: checked only by openmausbot doctor --data`;
      if (walBytes > largeWal) {
        const free = freeBytes(ctx.dataDir);
        const room = free === null || free > 2 * (dbBytes + walBytes);
        return { status: "problem", fixable: room && readable, detail: { file, verdict },
          summary: `${checked}; its write-ahead log is ${Math.round(walBytes / 1024 / 1024)} MB.`,
          ...(!room ? { instruction: "There is not room to copy it first: free some disk, then run openmausbot doctor --data --fix." }
            : !readable ? { instruction: "Too large to copy as the server starts: stop the server, then run openmausbot doctor --data --fix." } : {}) };
      }
      return { status: "ok", summary: `${checked}.`, detail: { verdict } };
    },
    fix(_ctx, finding, backup) {
      const { file } = finding.detail as { file: string };
      backup.copy("messages-db", file);
      for (const extra of [`${file}-wal`, `${file}-shm`]) if (existsSync(extra)) backup.copy("messages-db", extra);
      const db = new DatabaseSync(file, { timeout: busyTimeoutMs });
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
