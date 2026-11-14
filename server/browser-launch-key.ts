import { realpathSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { BrowserSpawnSpec } from "./browser-runtime.ts";

/** fnm's shell hook (`fnm env`, which a person's profile runs) puts a per-shell `<pid>_<epoch-ms>` link to the active
 * Node version on PATH: the link's name says nothing, the installation it resolves to does. Unix puts the link's
 * `bin` on PATH, Windows the link itself. */
const FNM_PER_SHELL = /(?:^|[\\/])fnm_multishells[\\/][^\\/]+(?:[\\/]bin)?[\\/]?$/u;
const FNM_UNRESOLVED = "fnm-multishell";

function fnmTarget(entry: string): string {
  try { return realpathSync.native(entry); }
  catch { return FNM_UNRESOLVED; }
}

function stablePath(path: string, platform: NodeJS.Platform): string {
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const entry of path.split((platform === "win32" ? win32 : posix).delimiter)) {
    if (!FNM_PER_SHELL.test(entry)) {
      entries.push(entry);
      continue;
    }
    const target = fnmTarget(entry);
    if (seen.has(target)) continue;
    seen.add(target);
    entries.push(target);
  }
  return entries.join((platform === "win32" ? win32 : posix).delimiter);
}

/** A running browser answers only the launch settings it started with: agent-browser relaunches Chrome without a word
 * when a command carries others, so a call with different ones is refused instead. */
export function launchSettingsKey(spec: BrowserSpawnSpec, platform: NodeJS.Platform = process.platform): string {
  const env = Object.entries(spec.env)
    .map(([name, value]) => [name, name === "PATH" && value !== undefined ? stablePath(value, platform) : value] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([spec.command, spec.args, env]);
}
