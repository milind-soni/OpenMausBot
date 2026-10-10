// Where Google's Windows Antigravity runtime unpacks itself, and how the
// space it leaves behind is reclaimed.
//
// Adapted from pingdotgg/t3code@c18e5ea6ed, MIT License, Copyright (c) 2026
// T3 Tools Inc. (full text in third_party/t3-code/LICENSE); modified:
//   - apps/server/src/provider/antigravityAuthSupport.ts:187-212, 238-253
//     (a short temp folder per instance, beside rather than inside the
//     profile, and TEMP/TMP pointed at it for the runtime);
//   - apps/server/src/provider/acp/AntigravitySessionFiles.ts:45-61 and
//     apps/server/src/provider/Drivers/AntigravityDriver.ts:121-132
//     (reclaim what earlier runs left behind when the driver starts).
// What OMB does differently: the folder is stable per instance, never per
// process, because the ACP pool's contractKey hashes the launch environment
// and a new TEMP per process would respawn on every turn. t3code's per-process
// run-* folders (AntigravityDriver.ts:202-227) are deliberately not copied.
// Because the folder is shared, the sweep removes only unpack folders whose
// process is gone instead of the whole folder. The user-started cleanup of the
// system temp folder is OMB's own; t3code never touches system temp.
//
// Background: agy_acp_server.exe is a PyInstaller one-file build. Every launch
// unpacks thousands of files (0.34-1.26 GB) into a new %TEMP%\_MEI... folder,
// and a forced stop (taskkill /T /F) skips PyInstaller's own cleanup, so the
// folder stays behind. PyInstaller names it `_MEI` + the unpacking process ID
// + a counter from _wtempnam: the ID is `%08x` since 6.22.1 and `%d` before
// (bootloader/src/pyi_utils_win32.c, pyi_create_temporary_application_directory).
import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readdir, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { DATA_DIR } from "../config.ts";

const UNPACK_PREFIX = "_MEI";
/** An unpack folder OMB has claimed by renaming it and is deleting. If the
 * delete stops part way, the next sweep finishes it. */
const CLAIM_PREFIX = ".omb-removing-";
/** Files at the root of every Antigravity unpack folder. Other programs use
 * PyInstaller too; without both of these a folder is not Antigravity's. */
const ANTIGRAVITY_MARKERS = ["agy_acp_licenses.txt", "python310.dll"] as const;
/** A folder this recent may still be unpacking, even if its ID looks free. */
export const SYSTEM_LEFTOVER_MIN_AGE_MS = 10 * 60_000;
const INSTANCE_FOLDER = /^[0-9a-f]{12}$/u;

/** The folder every instance's temp folder lives in. `tmp/` is already left
 * out of workspace backups (workspace-backup.ts EXCLUDED). */
export function antigravityTempRoot(dataDir: string = DATA_DIR): string {
  return join(dataDir, "tmp", "agy");
}

/** Used in place of an instance ID for the one temp folder every runtime
 * verification shares. It has a space, which no instance ID has, so no
 * instance shares the folder. Being one fixed folder, what a verification
 * leaves behind (a runtime that would not stop) is swept like an instance's
 * leftovers: after the next verification and when the driver starts. */
export const VERIFICATION_TEMP_KEY = "runtime verification";

/** One stable, short temp folder per instance. Short, because the runtime
 * unpacks files up to 120 characters deep and Windows paths stop at 260.
 * Hashed, so instance IDs that differ only in case stay apart on
 * case-insensitive disks. */
export function antigravityTempDir(dataDir: string, instanceId: string): string {
  const key = createHash("sha256").update(instanceId).digest("hex").slice(0, 12);
  return join(antigravityTempRoot(dataDir), key);
}

/** Point the runtime's temp folder at `directory`. Windows only: that is
 * where the runtime unpacks itself. Windows environment names ignore case,
 * so an inherited `Temp` or `tmp` would otherwise sit beside ours and either
 * could win. */
export function setAntigravityTempEnvironment(
  environment: NodeJS.ProcessEnv,
  directory: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "win32") return;
  for (const key of Object.keys(environment)) {
    const upper = key.toUpperCase();
    if (upper === "TEMP" || upper === "TMP") delete environment[key];
  }
  environment.TEMP = directory;
  environment.TMP = directory;
}

/** Process IDs that could own an unpack folder with this name, or null when
 * the name is not a PyInstaller unpack folder at all.
 *
 * Since 6.22.1 the ID is 8 hex digits. Before that it is plain decimal and
 * runs straight into _wtempnam's decimal counter, so the split is ambiguous:
 * every split that leaves a 1-3 digit counter is a candidate. A folder counts
 * as abandoned only when every candidate is gone, so the guess can keep a
 * leftover a while longer but can never delete a live one. */
export function unpackFolderOwnerPids(name: string): number[] | null {
  if (!name.startsWith(UNPACK_PREFIX)) return null;
  const rest = name.slice(UNPACK_PREFIX.length);
  const pids = new Set<number>();
  if (/^[0-9a-f]{8}\d+$/iu.test(rest)) pids.add(Number.parseInt(rest.slice(0, 8), 16));
  if (/^[1-9]\d+$/u.test(rest)) {
    for (let counter = 1; counter <= 3 && counter < rest.length; counter++) {
      pids.add(Number.parseInt(rest.slice(0, rest.length - counter), 10));
    }
  }
  const valid = [...pids].filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  return valid.length ? valid : null;
}

/** Whether a process with this ID exists. Only "no such process" (ESRCH)
 * proves it is gone: EPERM means it exists but belongs to someone else. */
export function processIsAlive(
  pid: number,
  kill: (pid: number, signal: 0) => unknown = (target, signal) => process.kill(target, signal),
): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

export interface AntigravityTempOptions {
  dataDir?: string;
  /** Test seam. Defaults to processIsAlive. */
  isAlive?: (pid: number) => boolean;
}

export interface LeftoverFolder {
  path: string;
  where: "app" | "system";
  bytes: number;
}

export interface LeftoverScan {
  folders: LeftoverFolder[];
  bytes: number;
  /** False when counting ran out of time: `bytes` is then a lower bound. */
  complete: boolean;
}

export interface LeftoverRemoval {
  removed: number;
  freedBytes: number;
  /** Found but not removed: in use, not ours to judge yet, or out of time. */
  remaining: number;
}

function ownedByDeadProcess(name: string, isAlive: (pid: number) => boolean): boolean {
  const pids = unpackFolderOwnerPids(name);
  return pids !== null && !pids.some((pid) => isAlive(pid));
}

/** A real directory (not a link or junction to one), nothing there at all,
 * or anything else. */
async function entryKind(path: string): Promise<"directory" | "gone" | "other"> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink() ? "directory" : "other";
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "gone" : "other";
  }
}

async function realDirectory(path: string): Promise<boolean> {
  return (await entryKind(path)) === "directory";
}

async function listDirectory(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** The instance folders under OMB's temp root, each resolved through the
 * disk. Returns nothing when any step of dataDir/tmp/agy/<id> is a link or
 * junction, so a sweep can never be steered outside OMB's own folder. */
async function ownedTempDirectories(dataDir: string, only?: string): Promise<string[]> {
  const root = resolve(antigravityTempRoot(dataDir));
  let realRoot: string;
  try {
    const realData = await realpath(resolve(dataDir));
    realRoot = await realpath(root);
    if (realRoot !== join(realData, "tmp", "agy")) return [];
  } catch {
    return [];
  }
  const names = only === undefined
    ? (await listDirectory(root)).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    : [only];
  const owned: string[] = [];
  for (const name of names) {
    if (!INSTANCE_FOLDER.test(name)) continue;
    const directory = join(root, name);
    try {
      if (await realpath(directory) !== join(realRoot, name)) continue;
    } catch {
      continue;
    }
    owned.push(directory);
  }
  return owned;
}

/** Unpack folders in one OMB-owned temp folder whose process is gone, and
 * folders a previous sweep claimed but did not finish deleting. */
async function abandonedIn(directory: string, isAlive: (pid: number) => boolean): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await listDirectory(directory)) {
    // Dirent follows lstat: a link or junction is never a directory here.
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(CLAIM_PREFIX) || ownedByDeadProcess(entry.name, isAlive)) {
      found.push(join(directory, entry.name));
    }
  }
  return found;
}

async function isAntigravityUnpack(directory: string): Promise<boolean> {
  for (const marker of ANTIGRAVITY_MARKERS) {
    try {
      if (!(await lstat(join(directory, marker))).isFile()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Antigravity unpack folders in the system temp folder: both marker files,
 * no live owner, and untouched for ten minutes. Other apps (Zed, t3code)
 * start the same runtime, so this runs only when the person asks. */
async function systemLeftovers(
  systemTemp: string,
  isAlive: (pid: number) => boolean,
  now: number,
): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await listDirectory(systemTemp)) {
    if (!entry.isDirectory()) continue;
    const directory = join(systemTemp, entry.name);
    const claimed = entry.name.startsWith(CLAIM_PREFIX + UNPACK_PREFIX);
    if (!claimed && !ownedByDeadProcess(entry.name, isAlive)) continue;
    if (!claimed && !(await isAntigravityUnpack(directory))) continue;
    try {
      if (now - (await lstat(directory)).mtimeMs < SYSTEM_LEFTOVER_MIN_AGE_MS) continue;
    } catch {
      continue;
    }
    found.push(directory);
  }
  return found;
}

/** Bytes under a folder, without following links. Stops at the deadline. */
async function folderBytes(directory: string, deadline = Infinity): Promise<{ bytes: number; complete: boolean }> {
  let bytes = 0;
  const pending = [directory];
  while (pending.length) {
    if (Date.now() > deadline) return { bytes, complete: false };
    const current = pending.pop()!;
    for (const entry of await listDirectory(current)) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) {
        try { bytes += (await lstat(path)).size; } catch { /* already gone */ }
      }
    }
  }
  return { bytes, complete: true };
}

/** Claim a folder by renaming it, then delete it. On Windows the rename
 * fails while any process still has a file inside open (every live runtime
 * has its DLLs loaded), which is a second check after the process ID.
 * Returns the bytes freed; "gone" when someone else (the automatic sweep and
 * "Free up space" can pick the same folder) removed it first; or null when
 * the folder was left alone. */
async function claimAndRemove(directory: string, countBytes: boolean): Promise<number | "gone" | null> {
  const name = basename(directory);
  // Checked again at the last moment: the listing may be stale.
  const kind = await entryKind(directory);
  if (kind !== "directory") return kind === "gone" ? "gone" : null;
  let claimed = directory;
  if (!name.startsWith(CLAIM_PREFIX)) {
    claimed = join(dirname(directory), `${CLAIM_PREFIX}${name}-${randomUUID().slice(0, 8)}`);
    try {
      await rename(directory, claimed);
    } catch (error) {
      // Lost the race to another remover: the folder is gone, not in use.
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT" && (await entryKind(directory)) === "gone") return "gone";
      return null;
    }
  }
  const { bytes } = countBytes ? await folderBytes(claimed) : { bytes: 0 };
  try {
    await rm(claimed, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    return bytes;
  } catch {
    // The claimed name stays, and the next sweep finishes the job.
    return null;
  }
}

const sweeps = new Map<string, Promise<number>>();

/** Delete this instance's abandoned unpack folders. Runs when the driver
 * starts and before each launch (and, for VERIFICATION_TEMP_KEY, after each
 * runtime verification). Touches nothing outside dataDir/tmp/agy/<instance>.
 * Returns how many folders it removed. */
export function sweepAntigravityTemp(instanceId: string, options: AntigravityTempOptions = {}): Promise<number> {
  const dataDir = options.dataDir ?? DATA_DIR;
  const key = antigravityTempDir(dataDir, instanceId);
  const running = sweeps.get(key);
  if (running) return running;
  const sweep = (async () => {
    const isAlive = options.isAlive ?? processIsAlive;
    let removed = 0;
    for (const directory of await ownedTempDirectories(dataDir, basename(key))) {
      for (const folder of await abandonedIn(directory, isAlive)) {
        if (typeof await claimAndRemove(folder, false) === "number") removed++;
      }
    }
    return removed;
  })().finally(() => sweeps.delete(key));
  sweeps.set(key, sweep);
  return sweep;
}

/** Fire-and-forget form for launch paths: never delays or fails a turn. */
export function scheduleAntigravityTempSweep(instanceId: string, options: AntigravityTempOptions = {}): void {
  void sweepAntigravityTemp(instanceId, options).catch((error) => {
    console.warn(`antigravity: could not clear leftover runtime files: ${error instanceof Error ? error.message : String(error)}`);
  });
}

export interface LeftoverOptions extends AntigravityTempOptions {
  /** The system temp folder. Defaults to os.tmpdir(). */
  systemTemp?: string;
  /** The system temp folder is only searched on Windows. */
  platform?: NodeJS.Platform;
  now?: number;
  /** How long counting (scan) or starting new deletions (remove) may take. */
  budgetMs?: number;
}

async function leftoverCandidates(options: LeftoverOptions): Promise<Array<{ path: string; where: "app" | "system" }>> {
  const isAlive = options.isAlive ?? processIsAlive;
  const candidates: Array<{ path: string; where: "app" | "system" }> = [];
  for (const directory of await ownedTempDirectories(options.dataDir ?? DATA_DIR)) {
    for (const path of await abandonedIn(directory, isAlive)) candidates.push({ path, where: "app" });
  }
  if ((options.platform ?? process.platform) === "win32") {
    // TEMP itself may legitimately be a junction; what is inside it may not.
    const systemTemp = await realpath(resolve(options.systemTemp ?? tmpdir())).catch(() => null);
    if (systemTemp && await realDirectory(systemTemp)) {
      for (const path of await systemLeftovers(systemTemp, isAlive, options.now ?? Date.now())) {
        candidates.push({ path, where: "system" });
      }
    }
  }
  return candidates;
}

/** What "Free up space" would delete, and roughly how much it is. Deletes
 * nothing. */
export async function findAntigravityLeftovers(options: LeftoverOptions = {}): Promise<LeftoverScan> {
  const deadline = Date.now() + (options.budgetMs ?? 15_000);
  const folders: LeftoverFolder[] = [];
  let complete = true;
  for (const candidate of await leftoverCandidates(options)) {
    const counted = await folderBytes(candidate.path, deadline);
    complete &&= counted.complete;
    folders.push({ ...candidate, bytes: counted.bytes });
  }
  return { folders, bytes: folders.reduce((total, folder) => total + folder.bytes, 0), complete };
}

/** "Free up space": looks again rather than trusting an earlier scan, so a
 * folder that came back to life since is left alone. */
export async function removeAntigravityLeftovers(options: LeftoverOptions = {}): Promise<LeftoverRemoval> {
  const deadline = Date.now() + (options.budgetMs ?? 120_000);
  const candidates = await leftoverCandidates(options);
  let removed = 0;
  let alreadyGone = 0;
  let freedBytes = 0;
  for (const candidate of candidates) {
    if (Date.now() > deadline) break;
    const bytes = await claimAndRemove(candidate.path, true);
    if (bytes === "gone") alreadyGone++;
    if (typeof bytes !== "number") continue;
    removed++;
    freedBytes += bytes;
  }
  // A folder another remover got to first is not "still in use".
  return { removed, freedBytes, remaining: candidates.length - removed - alreadyGone };
}
