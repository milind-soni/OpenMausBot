// What the checks share about files: the temp file an interrupted atomic write leaves (atomic.ts), and whether a
// registry file holds a list.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { DoctorContext } from "./types.ts";

/** atomic.ts writeWhole's temp file, `<file>.<pid>.<uuid>.tmp`, exactly; nothing else is ever taken for one. */
const ATOMIC_TEMP = /^(.+)\.([1-9]\d{0,9})\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;

export type LeftoverTemp = { name: string; path: string; of: string; pid: number; mtimeMs: number };

/** The temp files in `dir` (not below it) whose writer is no longer running: never a live process's, and this process's
 * pid only for a file older than this process (a restarted container's server is often given its predecessor's pid). */
export function leftoverTemps(ctx: DoctorContext, dir: string = ctx.dataDir): LeftoverTemp[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const found: LeftoverTemp[] = [];
  for (const name of names) {
    const match = ATOMIC_TEMP.exec(name);
    if (!match) continue;
    const pid = Number(match[2]);
    if (pid !== process.pid && ctx.pidAlive(pid)) continue;
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      if (!stat.isFile() || (pid === process.pid && stat.mtimeMs >= ctx.startedAt)) continue;
      found.push({ name, path, of: match[1]!, pid, mtimeMs: stat.mtimeMs });
    } catch {}
  }
  return found;
}

/** "missing"; "ok" when the file parses as a JSON list; "damaged" when it was read and is not one (empty, cut short, not a
 * list); "unreadable" when it could not be read at all (permissions, a folder in its place): that says nothing about the
 * file, and is never repaired or reported as damage. */
export type RegistryState = { state: "missing" | "ok" | "damaged" } | { state: "unreadable"; reason: string };

export function registryState(path: string): RegistryState {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // The code only: an fs message carries the full path.
    return code === "ENOENT" ? { state: "missing" } : { state: "unreadable", reason: code ?? "read error" };
  }
  try { return { state: Array.isArray(JSON.parse(text)) ? "ok" : "damaged" }; } catch { return { state: "damaged" }; }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
