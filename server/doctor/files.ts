// What the checks share about files: the temp file an interrupted atomic write leaves (atomic.ts), and whether a
// registry file holds a list.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { DoctorContext } from "./types.ts";

/** atomic.ts writeWhole's temp file, `<file>.<pid>.<uuid>.tmp`, exactly; nothing else is ever taken for one. */
const ATOMIC_TEMP = /^(.+)\.([1-9]\d{0,9})\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;

export type LeftoverTemp = { name: string; path: string; of: string; pid: number; mtimeMs: number };

/** The temp files in `dir` (not below it) whose writer is no longer running: never this process's, never a live one's. */
export function leftoverTemps(ctx: DoctorContext, dir: string = ctx.dataDir): LeftoverTemp[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const found: LeftoverTemp[] = [];
  for (const name of names) {
    const match = ATOMIC_TEMP.exec(name);
    if (!match) continue;
    const pid = Number(match[2]);
    if (pid === process.pid || ctx.pidAlive(pid)) continue;
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      if (stat.isFile()) found.push({ name, path, of: match[1]!, pid, mtimeMs: stat.mtimeMs });
    } catch {}
  }
  return found;
}

/** "missing", "ok" when the file parses as a JSON list, else "unreadable" (empty, cut short, not a list, not readable). */
export function registryState(path: string): "missing" | "ok" | "unreadable" {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
  }
  try { return Array.isArray(JSON.parse(text)) ? "ok" : "unreadable"; } catch { return "unreadable"; }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
