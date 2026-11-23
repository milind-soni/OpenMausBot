// A Cloud home's full tool results (tool-results/<thread>/) are swept on a timer: every file older than a day goes.
//
// Two writers share each conversation's folder. The MCP gate (mcp-gate.ts) saves a large result there and hands the
// model the path; it already removes its folder's files older than SPILL_MAX_AGE_MS (a day), but only when a gate
// starts in that conversation. The engine hook (index.ts, tool-result-spill.ts) saves each tool's full output as
// <hash>.txt; nothing reads those back (a row keeps only `fullResult: true`). So the same one-day rule, run for every
// conversation, removes nothing a turn or the person still reads.
//
// Size first, age as the tie-breaker: past CAP_BYTES the hook's outputs (nothing reads them back) go oldest first, down
// to an hour old. The gate's saved results keep the day: a model may be told to read one later the same day.
// Nothing is removed while any turn runs.
//
// Files only: both writers make their folder and then write into it, so a folder removed between the two would fail
// the write. Folders of deleted conversations go with the conversation. A link is never followed or removed.
import { lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setImmediate as yieldNow, setTimeout as sleep } from "node:timers/promises";

export type ToolResultsSweepMode = "off" | "report" | "on";

/** The MCP gate's own age for its saved results (mcp-gate.ts SPILL_MAX_AGE_MS). */
export const MAX_AGE_MS = 24 * 60 * 60_000;
/** Past this, the hook's outputs younger than a day go too, oldest first. */
export const CAP_BYTES = 1024 ** 3;
/** Never under the cap: a result this new may belong to a turn that has just paused. */
export const MIN_AGE_MS = 60 * 60_000;
/** The engine hook's full tool output (tool-result-spill.ts): a sha256 of its key, then .txt. */
const HOOK_OUTPUT = /^[0-9a-f]{64}\.txt$/;
/** Soon after a start (a home that sleeps by stopping may be up only minutes), after the logs' sweep (3 minutes) and
 * before the engine sessions' (7), so the three do not start at once. */
export const FIRST_PASS_MS = 5 * 60_000;
/** A pass that stopped for a turn, a move or a backup is tried again this soon. */
export const RETRY_MS = 30 * 60_000;
/** When the last whole pass ended, under the data folder's cache/ (left out of backups). */
export const STAMP_FILE = join("cache", "tool-results-sweep.json");
/** While a turn runs nothing is removed: the pass waits this long for a quiet moment, then stops until the next. */
export const TURN_WAIT_MS = 10 * 60_000;
const TURN_POLL_MS = 15_000;
export const PASS_EVERY_MS = 6 * 60 * 60_000;
const YIELD_EVERY = 500;

/** OMB_TOOL_RESULTS_SWEEP: `report` (or `dry-run`) counts and changes nothing; `on` removes; anything else is off. */
export function toolResultsSweepMode(env: NodeJS.ProcessEnv): ToolResultsSweepMode {
  const raw = env.OMB_TOOL_RESULTS_SWEEP?.trim().toLowerCase();
  if (raw === "report" || raw === "dry-run") return "report";
  return raw === "on" ? "on" : "off";
}

export interface ToolResultsSweepResult {
  mode: Exclude<ToolResultsSweepMode, "off">;
  folders: number;
  files: number;
  bytes: number;
  /** Of `files`, those removed younger than a day because the folder was over CAP_BYTES. */
  overCap: number;
  stopped: boolean;
}

/** True once nothing is paused and no turn runs; false when paused, or still busy after `waitMs`. */
async function quietMoment(deps: { paused?(): boolean; turnsRunning?(): boolean }, waitMs: number): Promise<boolean> {
  for (let waited = 0; ; waited += TURN_POLL_MS) {
    if (deps.paused?.()) return false;
    if (!deps.turnsRunning?.()) return true;
    if (waited >= waitMs) return false;
    await sleep(Math.min(TURN_POLL_MS, waitMs - waited), undefined, { ref: false });
  }
}

async function stat(path: string) {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

export async function sweepToolResults(deps: {
  root: string;
  mode: Exclude<ToolResultsSweepMode, "off">;
  paused?(): boolean;
  /** Any turn running anywhere on this server. */
  turnsRunning?(): boolean;
  turnWaitMs?: number;
  cap?: number;
  now?(): number;
}): Promise<ToolResultsSweepResult> {
  const now = deps.now?.() ?? Date.now();
  const cap = deps.cap ?? CAP_BYTES;
  const result: ToolResultsSweepResult = { mode: deps.mode, folders: 0, files: 0, bytes: 0, overCap: 0, stopped: false };
  if (!(await stat(deps.root))?.isDirectory()) return result;
  let seen = 0;
  const pace = async (): Promise<boolean> => {
    if (++seen % YIELD_EVERY === 0) await yieldNow();
    if (deps.paused?.()) result.stopped = true;
    return !result.stopped;
  };
  const remove = async (path: string, dev: number, ino: number): Promise<boolean> => {
    if (!(await quietMoment(deps, deps.turnWaitMs ?? TURN_WAIT_MS))) {
      result.stopped = true;
      return false;
    }
    if (deps.mode !== "on") return true;
    // The file listed and nothing else: the check is by device and inode, so a folder swapped for a link since the
    // listing reaches a different file and nothing goes. No await between the check and the unlink.
    try {
      const current = lstatSync(path);
      if (!current.isFile() || current.dev !== dev || current.ino !== ino) return false;
      unlinkSync(path);
      return true;
    } catch {
      return false;
    }
  };
  const young: Array<{ path: string; dev: number; ino: number; size: number; mtimeMs: number }> = [];
  let youngBytes = 0;
  const top = await opendir(deps.root).catch(() => null);
  if (!top) return result;
  for await (const folder of top) {
    if (!(await pace())) break;
    if (!folder.isDirectory()) continue;
    const dir = join(deps.root, folder.name);
    // Dirent says what readdir saw; a folder swapped for a link since then is caught here.
    if (!(await stat(dir))?.isDirectory()) continue;
    result.folders++;
    const inner = await opendir(dir).catch(() => null);
    if (!inner) continue;
    for await (const entry of inner) {
      if (!(await pace())) break;
      if (!entry.isFile()) continue;
      const path = join(dir, entry.name);
      const stats = await stat(path);
      if (!stats?.isFile()) continue;
      if (now - stats.mtimeMs < MAX_AGE_MS) {
        if (HOOK_OUTPUT.test(entry.name)) young.push({ path, dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs });
        youngBytes += stats.size;
        continue;
      }
      if (!(await remove(path, stats.dev, stats.ino))) {
        if (result.stopped) break;
        continue;
      }
      result.files++;
      result.bytes += stats.size;
    }
    if (result.stopped) return result;
  }
  young.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const file of young) {
    if (youngBytes <= cap || now - file.mtimeMs < MIN_AGE_MS) break;
    if (!(await remove(file.path, file.dev, file.ino))) {
      if (result.stopped) break;
      continue;
    }
    youngBytes -= file.size;
    result.files++;
    result.overCap++;
    result.bytes += file.size;
  }
  return result;
}

export function sweepLine(result: ToolResultsSweepResult): string {
  const verb = result.mode === "report" ? "would free" : "freed";
  return `[tool-results] ${result.mode}: ${result.files} saved results in ${result.folders} conversations (${result.overCap} under a day old, over the cap); ${verb} ${(result.bytes / 1024 / 1024).toFixed(1)} MB`
    + (result.stopped ? " (stopped for a move, a backup or a running turn; the next pass carries on)" : "");
}

/** Cloud homes only, and only with OMB_TOOL_RESULTS_SWEEP set: a pass when due, at the earliest FIRST_PASS_MS after start. */
export function startToolResultsSweep(deps: { cloudHome: boolean; env: NodeJS.ProcessEnv; dataDir: string; root: string; paused?(): boolean; turnsRunning?(): boolean; log?(line: string): void }): boolean {
  const mode = toolResultsSweepMode(deps.env);
  if (!deps.cloudHome || mode === "off") return false;
  const log = deps.log ?? ((line: string) => console.log(line));
  const pass = async (): Promise<boolean> => {
    // A frozen or backing-up home: no read, no change, and no stamp, so the pass is tried again soon.
    if (deps.paused?.()) return false;
    try {
      const result = await sweepToolResults({ root: deps.root, mode, paused: deps.paused, turnsRunning: deps.turnsRunning });
      if (result.files || result.stopped) log(sweepLine(result));
      return !result.stopped;
    } catch (error) {
      log(`[tool-results] pass failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };
  schedulePasses(join(deps.dataDir, STAMP_FILE), PASS_EVERY_MS, pass);
  return true;
}

/**
 * Runs `pass` FIRST_PASS_MS after start, or later when the last whole pass (saved in `stamp`) is not yet `every` old,
 * then every `every`; a pass that stopped early is tried again after RETRY_MS. A stamp from the future (a clock set
 * back) counts as none, and a home that slept past its time runs one pass on waking, never one per missed interval.
 */
export function schedulePasses(stamp: string, every: number, pass: () => Promise<boolean>, now: () => number = Date.now): void {
  const run = async () => {
    const whole = await pass();
    if (whole) {
      try {
        mkdirSync(dirname(stamp), { recursive: true, mode: 0o700 });
        writeFileSync(stamp, JSON.stringify({ at: now() }), { mode: 0o600 });
      } catch {}
    }
    setTimeout(() => void run(), whole ? every : RETRY_MS).unref();
  };
  // The stamp is read in the first timer, never while the server is still starting.
  const first = () => {
    let last: number | null = null;
    try {
      const at = (JSON.parse(readFileSync(stamp, "utf8")) as { at?: unknown }).at;
      if (typeof at === "number" && Number.isFinite(at) && at <= now()) last = at;
    } catch {}
    const wait = last === null ? 0 : last + every - now();
    if (wait > 0) setTimeout(() => void run(), wait).unref();
    else void run();
  };
  setTimeout(first, FIRST_PASS_MS).unref();
}
