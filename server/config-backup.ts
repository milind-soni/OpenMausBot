// Dated copies of the settings file, and the rule that a save never replaces a file it could not read.
//
// config.json holds every credential and connection of the install. A save that starts from a failed read writes
// only the patched sections over the whole file and the rest is gone: the dated copies are what make that
// recoverable, and the refusal is what keeps it from happening.
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { parseJson, type JsonObject } from "./schema.ts";
import { keepUnreadableAside } from "./unreadable-aside.ts";

/** The dated copies kept beside config.json: `config.json.bak.20261116-003000`. */
export const CONFIG_BACKUP_PREFIX = "config.json.bak.";
/** How many dated copies are kept; the oldest go first. */
export const CONFIG_BACKUP_KEEP = 10;

const BACKUP_NAME = /^config\.json\.bak\.(\d{8})-(\d{6})(?:-(\d+))?$/;

export interface ConfigBackup {
  /** The file name, which carries the moment the copy was taken. */
  name: string;
  path: string;
  /** `YYYYMMDD-HHMMSS` in UTC. */
  stamp: string;
  bytes: number;
}

export type ConfigFileRead =
  | { state: "missing" }
  | { state: "ok"; value: JsonObject; text: string }
  | { state: "unreadable"; reason: string }
  | { state: "invalid"; reason: string };

/** The moment a copy carries, and the number it was given inside that second. */
function backupOrder(name: string): { stamp: string; order: number } {
  const match = BACKUP_NAME.exec(name)!;
  return { stamp: `${match[1]}-${match[2]}`, order: match[3] ? Number(match[3]) : 0 };
}

/** The settings file as it is on disk. A file that is there but cannot be understood is never taken for an empty
 * one: it is reported, so a save can refuse to replace it. */
export function readConfigFile(path: string): ConfigFileRead {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
    return { state: "unreadable", reason: error instanceof Error ? error.message : "unable to read the file" };
  }
  try {
    const value = parseJson(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { state: "invalid", reason: "it is not a JSON object" };
    return { state: "ok", value: value as JsonObject, text };
  } catch {
    // A JSON error can quote the file, and the file holds credentials.
    return { state: "invalid", reason: "it is not valid JSON" };
  }
}

/** The error a save refuses with: the file on disk is left as it is, and its bytes are kept. */
export function configSaveRefusal(read: { state: "unreadable" | "invalid"; reason: string }, path: string): Error {
  const why = read.state === "invalid" ? `it is not a settings file (${read.reason})` : `it could not be read (${read.reason})`;
  const aside = read.state === "invalid" ? keepUnreadableAside(path) : null;
  const kept = aside ? ` A copy of it was kept at ${aside}.` : "";
  return Object.assign(
    new Error(`The settings file ${path} was left as it is because ${why}, so nothing was saved. Repair the file, or put a dated copy back with "openmausbot config restore".${kept}`),
    { status: 503 },
  );
}

/** The error a save refuses with when its dated copy could not be written: without that copy the file would be
 * replaced with nothing to go back to. */
export function configBackupRefusal(path: string): Error {
  return Object.assign(
    new Error(`The settings file ${path} was left as it is because its dated copy could not be written, so nothing was saved.`),
    { status: 503 },
  );
}

function stampOf(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

/** A dated copy of the file as it is now, kept beside it. `skip` is a copy that must not be written over. A copy that
 * cannot be written does not stop the save; the caller says so. */
export function writeConfigBackup(path: string, text: string, now: Date = new Date(), skip?: string): string | null {
  const dir = dirname(path);
  const base = CONFIG_BACKUP_PREFIX + stampOf(now);
  // The number continues above the ones already there, so a name that retention removed is never used again.
  let taken = 0;
  for (const copy of listConfigBackups(dir)) {
    if (copy.name.startsWith(base)) taken = Math.max(taken, backupOrder(copy.name).order + 1);
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const name = taken === 0 ? base : `${base}-${taken}`;
    taken += 1;
    if (name === skip) continue;
    const target = join(dir, name);
    if (existsSync(target)) continue;
    try {
      writeFileAtomic(target, text, { mode: 0o600 });
    } catch {
      return null;
    }
    pruneConfigBackups(dir);
    return name;
  }
  return null;
}

/** The dated copies kept beside the settings file, oldest first. Copies taken in the same second are ordered by the
 * number they carry, not by their name, so the tenth of a second comes after the ninth. */
export function listConfigBackups(dir: string): ConfigBackup[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => BACKUP_NAME.test(name))
    .sort((one, two) => {
      const first = backupOrder(one);
      const second = backupOrder(two);
      if (first.stamp !== second.stamp) return first.stamp < second.stamp ? -1 : 1;
      return first.order - second.order;
    })
    .map((name) => {
      const path = join(dir, name);
      let bytes = 0;
      try {
        bytes = statSync(path).size;
      } catch {
      }
      return { name, path, stamp: backupOrder(name).stamp, bytes };
    });
}

function pruneConfigBackups(dir: string): void {
  const copies = listConfigBackups(dir);
  for (const copy of copies.slice(0, Math.max(0, copies.length - CONFIG_BACKUP_KEEP))) {
    try {
      unlinkSync(copy.path);
    } catch {
    }
  }
}

export type ConfigRestore = { ok: true; name: string; kept: string | null; restored: boolean } | { ok: false; error: string };

/** Checks that a copy is a settings file the server can read: it returns the reason it is not, or null when it is. */
export type ConfigBackupCheck = (text: string) => string | null;

/** Puts a dated copy back as the settings file. The file it replaces is kept, so the restore is itself reversible.
 * A dry run reports what it would do and changes nothing. Nothing is put back over a file that cannot be read or
 * kept: a restore never loses what it finds. */
export function restoreConfigBackup(dir: string, name: string, options: { dryRun?: boolean; check?: ConfigBackupCheck } = {}): ConfigRestore {
  if (!BACKUP_NAME.test(name)) return { ok: false, error: `${name} is not a dated copy of the settings file; run openmausbot config backups to see the copies` };
  const source = join(dir, name);
  let text: string;
  try {
    text = readFileSync(source, "utf8");
  } catch {
    return { ok: false, error: `The copy ${name} could not be read; run openmausbot config backups to see the copies` };
  }
  try {
    const parsed = parseJson(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, error: `The copy ${name} is not a settings file, so it was not put back` };
  } catch {
    return { ok: false, error: `The copy ${name} is not valid JSON, so it was not put back` };
  }
  const problem = options.check?.(text);
  if (problem) return { ok: false, error: `The copy ${name} is not a settings file (${problem}), so it was not put back` };
  const target = join(dir, "config.json");
  const current = readConfigFile(target);
  if (current.state === "unreadable") return { ok: false, error: `The file ${target} could not be read, so it was left as it is and nothing was put back` };
  if (options.dryRun) return { ok: true, name, kept: null, restored: false };
  let kept: string | null = null;
  if (current.state === "ok") {
    const copy = writeConfigBackup(target, current.text, new Date(), name);
    if (!copy) return { ok: false, error: `The file ${target} could not be kept as a dated copy, so it was left as it is and nothing was put back` };
    kept = join(dir, copy);
  } else if (current.state === "invalid") {
    const aside = keepUnreadableAside(target);
    if (!aside) return { ok: false, error: `The file ${target} could not be kept as a copy, so it was left as it is and nothing was put back` };
    kept = aside;
  }
  writeFileAtomic(target, text, { mode: 0o600 });
  return { ok: true, name, kept, restored: true };
}
