// A Cloud home's full tool results (tool-results/<thread>/) are swept on a timer: every file older than a day goes.
//
// Two writers share each conversation's folder. The MCP gate (mcp-gate.ts) saves a large result there and hands the
// model the path; it already removes its folder's files older than SPILL_MAX_AGE_MS (a day), but only when a gate
// starts in that conversation. The engine hook (index.ts, tool-result-spill.ts) saves each tool's full output as
// <hash>.txt; nothing reads those back (a row keeps only `fullResult: true`). So the same one-day rule, run for every
// conversation, removes nothing a turn or the person still reads.
//
// Files only: both writers make their folder and then write into it, so a folder removed between the two would fail
// the write. Folders of deleted conversations go with the conversation. A link is never followed or removed.
import { lstat, opendir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate as yieldNow } from "node:timers/promises";

export type ToolResultsSweepMode = "off" | "report" | "on";

/** The MCP gate's own age for its saved results (mcp-gate.ts SPILL_MAX_AGE_MS). */
export const MAX_AGE_MS = 24 * 60 * 60_000;
export const FIRST_PASS_MS = 20 * 60_000;
export const PASS_EVERY_MS = 6 * 60 * 60_000;
const YIELD_EVERY = 500;

/** OMB_TOOL_RESULTS_SWEEP: `report` (or `dry-run`) counts and changes nothing; `on` removes; anything else is off. */
export function toolResultsSweepMode(env: NodeJS.ProcessEnv): ToolResultsSweepMode {
  const raw = env.OMB_TOOL_RESULTS_SWEEP?.trim().toLowerCase();
  if (raw === "report" || raw === "dry-run") return "report";
  return raw === "on" || raw === "1" || raw === "true" ? "on" : "off";
}

export interface ToolResultsSweepResult {
  mode: Exclude<ToolResultsSweepMode, "off">;
  folders: number;
  files: number;
  bytes: number;
  stopped: boolean;
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
  now?(): number;
}): Promise<ToolResultsSweepResult> {
  const now = deps.now?.() ?? Date.now();
  const result: ToolResultsSweepResult = { mode: deps.mode, folders: 0, files: 0, bytes: 0, stopped: false };
  if (!(await stat(deps.root))?.isDirectory()) return result;
  let seen = 0;
  const pace = async (): Promise<boolean> => {
    if (++seen % YIELD_EVERY === 0) await yieldNow();
    if (deps.paused?.()) result.stopped = true;
    return !result.stopped;
  };
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
      if (!stats?.isFile() || now - stats.mtimeMs < MAX_AGE_MS) continue;
      if (deps.mode === "on" && !(await unlink(path).then(() => true, () => false))) continue;
      result.files++;
      result.bytes += stats.size;
    }
    if (result.stopped) break;
  }
  return result;
}

export function sweepLine(result: ToolResultsSweepResult): string {
  const verb = result.mode === "report" ? "would free" : "freed";
  return `[tool-results] ${result.mode}: ${result.files} results older than a day in ${result.folders} conversations; ${verb} ${(result.bytes / 1024 / 1024).toFixed(1)} MB`
    + (result.stopped ? " (stopped for a move or backup; the next pass carries on)" : "");
}

/** Cloud homes only, and only with OMB_TOOL_RESULTS_SWEEP set: a pass FIRST_PASS_MS after start, then every PASS_EVERY_MS. */
export function startToolResultsSweep(deps: { cloudHome: boolean; env: NodeJS.ProcessEnv; root: string; paused?(): boolean; log?(line: string): void }): boolean {
  const mode = toolResultsSweepMode(deps.env);
  if (!deps.cloudHome || mode === "off") return false;
  const log = deps.log ?? ((line: string) => console.log(line));
  let running = false;
  const pass = async () => {
    if (running) return;
    running = true;
    try {
      const result = await sweepToolResults({ root: deps.root, mode, paused: deps.paused });
      if (result.files || result.stopped) log(sweepLine(result));
    } catch (error) {
      log(`[tool-results] pass failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
    }
  };
  setTimeout(() => void pass(), FIRST_PASS_MS).unref();
  setInterval(() => void pass(), PASS_EVERY_MS).unref();
  return true;
}
