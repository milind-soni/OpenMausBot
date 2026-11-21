// Security: while the bot box is on, a boxed bot can write the server's HOME (plan.ts binds it read-write). The server's
// own processes run outside the box, so they must never look a program up in a folder there, nor start one from there:
// a program a bot left in ~/.local/bin would otherwise run outside the box at the next engine status read. The data
// folder is the exception: the box replaces it with an empty one, and the engines the app installs there are read-only.
import { realpathSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";

import { under } from "./plan.ts";

let distrusted: { homes: readonly string[]; kept: readonly string[]; bots: readonly string[] } | null = null;

/** A folder as given and as the filesystem names it, so a link's target is judged by where it really is. */
function bothNames(dir: string): string[] {
  const given = resolve(dir);
  try { return [...new Set([given, realpathSync(given)])]; } catch { return [given]; }
}

/** Called with the server's HOME when the box goes on, and with null when it stops. `kept`: folders under HOME no bot
 * can write (the data folder); `bots`: the folders in it bots do write (their workspaces, a Team Cloud's engine homes). */
export function distrustHomePrograms(home: string | null, kept: readonly string[] = [], bots: readonly string[] = []): void {
  distrusted = home ? { homes: bothNames(home), kept: kept.flatMap(bothNames), bots: bots.flatMap(bothNames) } : null;
}

export function homeProgramsDistrusted(): boolean {
  return distrusted !== null;
}

/** Whether the server may run a program from `path` (a folder or a file) outside the box. */
export function serverMayRunFrom(path: string): boolean {
  if (!distrusted) return true;
  if (!isAbsolute(path)) return false;
  const full = resolve(path);
  if (distrusted.bots.some((dir) => under(full, dir))) return false;
  return !distrusted.homes.some((home) => under(full, home)) || distrusted.kept.some((dir) => under(full, dir));
}

/** `path` without the folders the server may not run programs from. */
export function serverPath(path: string | undefined): string {
  if (!distrusted) return path ?? "";
  return (path ?? "").split(delimiter).filter((dir) => dir && serverMayRunFrom(dir)).join(delimiter);
}
