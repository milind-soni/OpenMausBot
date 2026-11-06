// Run history lives beside routines.json in an append-only log: each line is one run's latest snapshot, so a status change
// writes the run that changed, not every routine and every run ever recorded. Routines and their settings stay in
// routines.json. A torn last line (a crash mid-append) is cut before the next write.
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, truncateSync, writeSync } from "node:fs";
import { dirname } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import type { RoutineRun } from "./routines.ts";

/** The log next to `routines.json`: `routines.runs.jsonl`. */
export function runJournalFile(routinesFile: string): string {
  return routinesFile.replace(/\.json$/i, "") + ".runs.jsonl";
}

/** Rewrite the log as one line per run once it holds this much, or eight lines per run still alive. */
const COMPACT_BYTES = 8 * 1024 * 1024;
const COMPACT_LINE_RATIO = 8;
const COMPACT_MIN_LINES = 5_000;

interface RunLine {
  v: 1;
  run?: RoutineRun;
  drop?: string;
}

function isRun(value: unknown): value is RoutineRun {
  const run = value as Partial<RoutineRun> | null;
  return !!run && typeof run.id === "string" && typeof run.routineId === "string" && typeof run.status === "string";
}

function parseLine(text: string): RunLine | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const line = value as Partial<RunLine> | null;
  if (!line || line.v !== 1) return null;
  if (typeof line.drop === "string" && line.drop) return { v: 1, drop: line.drop };
  return isRun(line.run) ? { v: 1, run: line.run } : null;
}

const serialize = (runs: readonly RoutineRun[]): string =>
  runs.map((run) => JSON.stringify({ v: 1, run } satisfies RunLine)).join("\n") + (runs.length ? "\n" : "");

export interface RunJournal {
  readonly file: string;
  /**
   * The runs the log holds, with `legacy` (runs still inside an older `routines.json`) filling ids the log never saw.
   * `migrated` asks the caller to save, which moves the legacy runs into the log and drops them from the JSON.
   */
  load(legacy: readonly RoutineRun[]): { runs: RoutineRun[]; migrated: boolean };
  /** Appends only runs whose JSON changed since the last write, and a tombstone for each removed run. */
  write(runs: readonly RoutineRun[]): void;
  /** Rewrites the log as exactly these runs, dropping superseded snapshots and tombstones. */
  compact(runs: readonly RoutineRun[]): void;
}

export function openRunJournal(file: string): RunJournal {
  let persisted = new Map<string, string>();
  let lines = 0;
  let bytes = 0;
  let torn = false;

  const read = (): string => {
    try {
      const text = readFileSync(file, "utf8");
      bytes = Buffer.byteLength(text);
      return text;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      bytes = 0;
      return "";
    }
  };

  const cutTornTail = (text: string): string => {
    if (!text || text.endsWith("\n")) return text;
    const end = text.lastIndexOf("\n") + 1;
    try {
      truncateSync(file, end);
      bytes = end;
      return text.slice(0, end);
    } catch {
      torn = true;
      return text;
    }
  };

  const append = (records: RunLine[]): void => {
    if (!records.length) return;
    mkdirSync(dirname(file), { recursive: true });
    const text = (torn ? "\n" : "") + records.map((record) => JSON.stringify(record)).join("\n") + "\n";
    // One small append, fsynced like the whole-file save it replaces: a power loss still keeps every completed transition.
    const fd = openSync(file, "a", 0o600);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } catch (error) {
      torn = true;
      throw error;
    } finally {
      closeSync(fd);
    }
    try { chmodSync(file, 0o600); } catch { /* Windows has no meaningful mode bits */ }
    torn = false;
    bytes += Buffer.byteLength(text);
    lines += records.length;
  };

  const rewrite = (runs: readonly RoutineRun[]): void => {
    const text = serialize(runs);
    writeFileAtomic(file, text, { mode: 0o600 });
    persisted = new Map(runs.map((run) => [run.id, JSON.stringify(run)]));
    lines = runs.length;
    bytes = Buffer.byteLength(text);
    torn = false;
  };

  return {
    file,

    load(legacy) {
      const text = cutTornTail(read());
      const order: string[] = [];
      const byId = new Map<string, RoutineRun>();
      for (const run of legacy) {
        if (byId.has(run.id)) continue;
        byId.set(run.id, run);
        order.push(run.id);
      }
      let logLines = 0;
      for (const line of text.split("\n")) {
        if (!line) continue;
        logLines += 1;
        const record = parseLine(line);
        if (!record) continue;
        if (record.drop) {
          byId.delete(record.drop);
          persisted.delete(record.drop);
          const at = order.indexOf(record.drop);
          if (at >= 0) order.splice(at, 1);
          continue;
        }
        const run = record.run!;
        if (!byId.has(run.id)) order.push(run.id);
        byId.set(run.id, run);
        persisted.set(run.id, JSON.stringify(run));
      }
      lines = logLines;
      return { runs: order.flatMap((id) => byId.get(id) ?? []), migrated: legacy.length > 0 };
    },

    write(runs) {
      const records: RunLine[] = [];
      const next = new Map(persisted);
      const live = new Set<string>();
      for (const run of runs) {
        live.add(run.id);
        const text = JSON.stringify(run);
        if (next.get(run.id) === text) continue;
        records.push({ v: 1, run });
        next.set(run.id, text);
      }
      for (const id of next.keys()) {
        if (live.has(id)) continue;
        records.push({ v: 1, drop: id });
        next.delete(id);
      }
      append(records);
      persisted = next;
      if (bytes > COMPACT_BYTES || (lines > COMPACT_MIN_LINES && lines > runs.length * COMPACT_LINE_RATIO)) rewrite(runs);
    },

    compact: rewrite,
  };
}
