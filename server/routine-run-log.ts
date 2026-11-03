// Terminal routine runs, appended once and never rewritten after: the same append-only pattern usage-ledger.ts uses
// for usage rows, so routines.json stays small and a save never re-serializes history that cannot change anymore.
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { RoutineRun } from "./routines.ts";

const FILE_NAME = "routine-runs.jsonl";
/** Compacted once the log holds this many lines past what is kept, instead of on every append. */
const COMPACT_SLACK = 500;

export function runLogPathFor(routinesFile: string): string {
  return join(dirname(routinesFile), FILE_NAME);
}

/** One terminal run, appended once; never rewritten again. */
export function appendRunLog(path: string, run: RoutineRun): void {
  try {
    appendFileSync(path, `${JSON.stringify(run)}\n`, { mode: 0o600 });
  } catch (error) {
    console.error(`routine run log: could not append to ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The log's rows, oldest first; `keep` negative reads everything, otherwise its most recent `keep` rows. A line that
 * cannot parse (a crash mid-write) is skipped, never fatal to the rest of the log. */
export function readRunLog(path: string, keep: number): RoutineRun[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const rows: RoutineRun[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      rows.push(JSON.parse(line) as RoutineRun);
    } catch {
      // One bad line never loses the rest of the log.
    }
  }
  return keep >= 0 ? rows.slice(-keep) : rows;
}

/** Rewrites the log with only its most recent `keep` rows, once it has grown comfortably past that; a no-op most of
 * the time, so a routine finishing never pays this cost. */
export function compactRunLog(path: string, keep: number): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  const lines = text.split("\n").filter(Boolean);
  if (lines.length <= keep + COMPACT_SLACK) return;
  const tmp = `${path}.compacting-${process.pid}`;
  writeFileSync(tmp, `${lines.slice(-keep).join("\n")}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}
