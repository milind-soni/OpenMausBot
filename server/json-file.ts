// Crash-safe JSON persistence for ~/.gbs. Writes go to a temp file and are
// renamed over the target, so a crash or power loss leaves either the old
// file or the new one — never a truncated one. A file that fails to parse is
// moved aside (not overwritten by the next save), so a bad write can't
// silently turn into "no bots, no rooms, no keys".
import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

// Windows can briefly refuse a rename while antivirus or the indexer holds
// the target open; a short retry avoids failing the save.
function renameWithRetry(from: string, to: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      return renameSync(from, to);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || (code !== "EPERM" && code !== "EBUSY") || attempt >= 4) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
    }
  }
}

/** Atomically replace `path` with `value` as pretty JSON, owner-only (0600). */
export function writeJsonAtomic(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameWithRetry(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {}
    throw error;
  }
}

/**
 * Read JSON from `path`. A missing file yields `fallback`. An unreadable or
 * corrupt file is renamed to `<path>.corrupt-<timestamp>` (kept for recovery)
 * and also yields `fallback`.
 */
export function readJsonFile<T>(path: string, fallback: T): T {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    const aside = `${path}.corrupt-${Date.now()}`;
    try {
      renameSync(path, aside);
      console.error(`[gbs] ${path} was not valid JSON; kept it as ${aside} and started fresh`);
    } catch {
      console.error(`[gbs] ${path} was not valid JSON and could not be moved aside`);
    }
    return fallback;
  }
}

/** Tighten an existing secrets file written by an older build (no-op if absent). */
export function restrictToOwner(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    /* missing file, or a filesystem without POSIX modes */
  }
}
