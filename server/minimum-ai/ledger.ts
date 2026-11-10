import { closeSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { processAlive } from "./process-alive.ts";

type State = "running" | "completed" | "failed" | "interrupted";
const validId = (id: string) => /^[\w-]{1,128}$/.test(id) && !["__proto__", "constructor", "prototype"].includes(id);

export function createRunLedger(file: string) {
  try { closeSync(openSync(file, "wx", 0o600)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const use = <T>(operation: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(file);
    try {
      db.exec("PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, routine_id TEXT NOT NULL, pid INTEGER NOT NULL, state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'failed', 'interrupted'))) STRICT; CREATE UNIQUE INDEX IF NOT EXISTS active_routine ON runs (routine_id) WHERE state = 'running'; CREATE TABLE IF NOT EXISTS holds (routine_id TEXT PRIMARY KEY, run_id TEXT NOT NULL) STRICT");
      return operation(db);
    } finally { db.close(); }
  };
  return {
    recoverInterrupted(): void {
      use((db) => { db.prepare("UPDATE runs SET state = 'interrupted' WHERE state = 'running'").run(); });
    },
    begin(id: string, routineId = id): boolean {
      if (!validId(id) || !validId(routineId)) throw new Error("Invalid run ID");
      return use((db) => {
        db.exec("BEGIN IMMEDIATE");
        try {
          if (db.prepare("SELECT 1 FROM holds WHERE routine_id = ?").get(routineId)) { db.exec("COMMIT"); return false; }
          const active = db.prepare("SELECT id, pid FROM runs WHERE routine_id = ? AND state = 'running'").get(routineId) as { id: string; pid: number } | undefined;
          if (active && !processAlive(active.pid)) {
            db.prepare("UPDATE runs SET state = 'interrupted' WHERE id = ? AND state = 'running'").run(active.id);
            db.prepare("INSERT OR IGNORE INTO holds (routine_id, run_id) VALUES (?, ?)").run(routineId, active.id);
            db.exec("COMMIT"); return false;
          }
          const started = Number(db.prepare("INSERT OR IGNORE INTO runs (id, routine_id, pid, state) VALUES (?, ?, ?, 'running')").run(id, routineId, process.pid).changes) === 1;
          db.exec("COMMIT");
          return started;
        } catch (error) { db.exec("ROLLBACK"); throw error; }
      });
    },
    finish(id: string, result: "completed" | "failed", holdRoutine?: string): void {
      use((db) => {
        db.exec("BEGIN IMMEDIATE");
        try {
          if (Number(db.prepare("UPDATE runs SET state = ? WHERE id = ? AND state = 'running'").run(result, id).changes) !== 1) throw new Error("Run is not active");
          if (holdRoutine) db.prepare("INSERT OR IGNORE INTO holds (routine_id, run_id) VALUES (?, ?)").run(holdRoutine, id);
          db.exec("COMMIT");
        } catch (error) { db.exec("ROLLBACK"); throw error; }
      });
    },
    hold(routineId: string, runId: string): void {
      use((db) => { db.prepare("INSERT OR IGNORE INTO holds (routine_id, run_id) VALUES (?, ?)").run(routineId, runId); });
    },
    status(id: string): State | undefined {
      return use((db) => (db.prepare("SELECT state FROM runs WHERE id = ?").get(id) as { state: State } | undefined)?.state);
    },
    held(routineId: string): boolean {
      return use((db) => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const active = db.prepare("SELECT id, pid FROM runs WHERE routine_id = ? AND state = 'running'").get(routineId) as { id: string; pid: number } | undefined;
          if (active && !processAlive(active.pid)) {
            db.prepare("UPDATE runs SET state = 'interrupted' WHERE id = ? AND state = 'running'").run(active.id);
            db.prepare("INSERT OR IGNORE INTO holds (routine_id, run_id) VALUES (?, ?)").run(routineId, active.id);
          }
          const held = Boolean(db.prepare("SELECT 1 FROM holds WHERE routine_id = ?").get(routineId));
          db.exec("COMMIT"); return held;
        } catch (error) { db.exec("ROLLBACK"); throw error; }
      });
    },
    acknowledge(routineId: string): void {
      use((db) => { db.prepare("DELETE FROM holds WHERE routine_id = ?").run(routineId); });
    },
  };
}
