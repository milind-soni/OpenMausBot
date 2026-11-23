// Walking and deleting inside a cache folder a bot can write in, without ever leaving it (docs/bot-box.md, "Tool caches:
// the cap"). Every step goes through a folder the sweeper holds open, never through a path read again by name:
//   - a folder is opened with O_DIRECTORY | O_NOFOLLOW, so a link is never entered;
//   - each step below it names one plain child of an open folder through /proc/self/fd/<fd>/<name>, which the kernel
//     resolves from that open folder (Linux's openat, from Node), so a folder above that a bot swaps for a link
//     changes nothing: the open folder is still the one the walk began in;
//   - a folder on another filesystem (a different device) is never entered or removed;
//   - lstat, unlink and rmdir act on the last name itself and never follow it: a link swapped in is removed as a link,
//     or left; a folder's permissions are changed through its own open handle (fchmod).
//   - a folder about to go is first renamed, inside the same open parent, to a TRASH_PREFIX name, so a tool that starts
//     meanwhile finds it gone rather than half there; it is never put back, and a later pass finishes any leftover;
//   - a walk goes at most MAX_DEPTH folders deep (each level holds one open folder), so a bot's endlessly nested folders
//     cannot use up the server's open files or memory: what lies deeper is left, and the walk says it was partial.
// So the sweeper can delete only what is inside the folder it opened, which a bot that writes there could delete itself.
// Needs Linux's /proc/self/fd: anywhere else nothing is walked or deleted (anchoredSupported).
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, rename, rmdir, unlink, type FileHandle } from "node:fs/promises";

import { RECENT_MS, TICK_ENTRIES, TICK_PAUSE_MS, YIELD_EVERY } from "./limits.ts";

/** Whether this system can walk by open folders (Linux only). */
export function anchoredSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "linux";
}

const FOLDER_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
/** How deep a walk goes. A tool's cache is a few levels deep (npx's node_modules perhaps 20); deeper is left. */
export const MAX_DEPTH = 128;
/** What a folder being removed is renamed to first, in its own parent. */
export const TRASH_PREFIX = ".omb-trash-";

export interface Folder {
  handle: FileHandle;
  dev: number;
  ino: number;
}

/** The path that names `name` inside the open `folder` (or the folder itself), resolved from the open folder. */
const at = (folder: Folder, name?: string) => `/proc/self/fd/${folder.handle.fd}${name === undefined ? "" : `/${name}`}`;
const plainName = (name: string) => name !== "" && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\0");

async function opened(handle: FileHandle, dev: number | null): Promise<Folder | null> {
  try {
    const stat = await handle.stat();
    if (stat.isDirectory() && (dev === null || Number(stat.dev) === dev)) return { handle, dev: Number(stat.dev), ino: Number(stat.ino) };
  } catch { /* closed below */ }
  await handle.close().catch(() => {});
  return null;
}

/** Opens the folder at `path`; null when it is missing, a link, or not a folder. Only the last name is checked: the server
 * calls it for folders whose parents no bot can change (HOME, an engine home, the data folder). */
export async function openFolder(path: string): Promise<Folder | null> {
  if (!anchoredSupported()) return null;
  const handle = await open(path, FOLDER_FLAGS).catch(() => null);
  return handle ? opened(handle, null) : null;
}

/** Opens `name` inside `parent`: null when it is missing, a link, not a folder, or on another filesystem. */
export async function openChild(parent: Folder, name: string): Promise<Folder | null> {
  if (!plainName(name)) return null;
  const handle = await open(at(parent, name), FOLDER_FLAGS).catch(() => null);
  return handle ? opened(handle, parent.dev) : null;
}

/** Opens `parts` below `root`, one open folder at a time; the folders on the way are closed again. */
export async function openPath(root: Folder, parts: readonly string[]): Promise<Folder | null> {
  let current = root;
  for (const part of parts) {
    const next = await openChild(current, part);
    if (current !== root) await current.handle.close().catch(() => {});
    if (!next) return null;
    current = next;
  }
  return current;
}

export async function close(folder: Folder | null): Promise<void> {
  await folder?.handle.close().catch(() => {});
}

/** A regular file's text inside `folder`, never through a link; null when it is not one. */
export async function readPlainFile(folder: Folder, name: string, max = 4096): Promise<string | null> {
  if (!plainName(name)) return null;
  const handle = await open(at(folder, name), constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!handle) return null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > max) return null;
    return await handle.readFile("utf8");
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Plain names in an open folder, sorted; none when it cannot be listed. */
export async function names(folder: Folder): Promise<string[]> {
  try { return (await readdir(at(folder))).filter(plainName).sort(); } catch { return []; }
}

export interface Pace { entries: number; yieldEvery: number; pauseMs: number }
export const DEFAULT_PACE: Pace = { entries: TICK_ENTRIES, yieldEvery: YIELD_EVERY, pauseMs: TICK_PAUSE_MS };

/** Counts walked entries: yields to the event loop every `yieldEvery`, and pauses after `entries` (a tick's budget). */
export class Pacer {
  private count = 0;
  private readonly pace: Pace;
  constructor(pace: Pace = DEFAULT_PACE) { this.pace = pace; }
  async step(): Promise<void> {
    this.count += 1;
    if (this.count % this.pace.entries === 0) await new Promise((done) => setTimeout(done, this.pace.pauseMs));
    else if (this.count % this.pace.yieldEvery === 0) await new Promise((done) => setImmediate(done));
  }
}

export interface Tally {
  bytes: number;
  files: number;
  /** The newest modification or change time of anything in it (ms): its last write. */
  newest: number;
  /** Something could not be read or removed (another filesystem, a folder that went away mid-walk, a refusal). */
  partial: boolean;
}

const emptyTally = (): Tally => ({ bytes: 0, files: 0, newest: 0, partial: false });
type Stat = Awaited<ReturnType<typeof lstat>>;
const note = (tally: Tally, stat: Stat) => {
  tally.bytes += typeof stat.blocks === "number" && stat.blocks > 0 ? Number(stat.blocks) * 512 : Number(stat.size);
  tally.files += 1;
  tally.newest = Math.max(tally.newest, Number(stat.mtimeMs), Number(stat.ctimeMs));
};

/** Walks the open `folder` (sizes, files, last write); with `remove`, deletes everything inside it as it goes, leaving
 * the folder itself. A child folder is entered only through its own open handle, on the same filesystem. */
export async function walk(folder: Folder, options: { remove: boolean; pacer: Pacer }, tally: Tally = emptyTally(), depth = 0): Promise<Tally> {
  if (depth >= MAX_DEPTH) { tally.partial = true; return tally; }
  if (options.remove) {
    // A folder without write permission (a read-only tree) cannot be emptied: made writable through its own handle.
    const own = await folder.handle.stat().catch(() => null);
    if (own && (Number(own.mode) & 0o200) === 0) await folder.handle.chmod((Number(own.mode) & 0o7777) | 0o700).catch(() => {});
  }
  for (const name of await names(folder)) {
    await options.pacer.step();
    const stat = await lstat(at(folder, name)).catch(() => null);
    if (!stat) continue;
    if (stat.isDirectory()) {
      if (Number(stat.dev) !== folder.dev) { tally.partial = true; continue; }
      const child = await openChild(folder, name);
      if (!child) { tally.partial = true; continue; }
      note(tally, stat);
      try { await walk(child, options, tally, depth + 1); } finally { await close(child); }
      if (options.remove) await rmdir(at(folder, name)).catch(() => { tally.partial = true; });
      continue;
    }
    note(tally, stat);
    if (options.remove) await unlink(at(folder, name)).catch(() => { tally.partial = true; });
  }
  return tally;
}

/** Walks `name` inside the open `parent` (null: it is not there, or is a link or on another filesystem). */
export async function measureChild(parent: Folder, name: string, pacer: Pacer): Promise<Tally | null> {
  const stat = await lstat(at(parent, name)).catch(() => null);
  const child = stat?.isDirectory() ? await openChild(parent, name) : null;
  if (!stat || !child) return null;
  try {
    const tally = await walk(child, { remove: false, pacer });
    note(tally, stat);
    return tally;
  } finally {
    await close(child);
  }
}

/** Deletes the folder `name` inside the open `parent` and everything in it, never leaving it: renamed first to a
 * TRASH_PREFIX name in the same parent, then emptied and removed. Null when `name` is not a folder there (missing, a
 * link, a file). Returns what it walked; `partial` when anything stayed (a later pass finishes it, removeLeftovers). */
export async function removeChild(parent: Folder, name: string, pacer: Pacer): Promise<Tally | null> {
  if (!plainName(name) || name.startsWith(TRASH_PREFIX)) return null;
  const stat = await lstat(at(parent, name)).catch(() => null);
  if (!stat?.isDirectory() || Number(stat.dev) !== parent.dev) return null;
  const trash = `${TRASH_PREFIX}${randomBytes(6).toString("hex")}`;
  try { await rename(at(parent, name), at(parent, trash)); } catch { return null; }
  return removeTrash(parent, trash, pacer);
}

/** Removes a TRASH_PREFIX entry of the open `parent`: a folder through its own open handle; anything else (a link a bot
 * swapped in before the rename) as itself, never followed. */
async function removeTrash(parent: Folder, trash: string, pacer: Pacer): Promise<Tally> {
  const child = await openChild(parent, trash);
  if (!child) {
    await unlink(at(parent, trash)).catch(() => {});
    return { ...emptyTally(), partial: true };
  }
  let tally: Tally;
  try { tally = await walk(child, { remove: true, pacer }); } finally { await close(child); }
  await rmdir(at(parent, trash)).catch(() => { tally.partial = true; });
  return tally;
}

/** Finishes the TRASH_PREFIX entries an earlier removal left in the open `parent`. */
export async function removeLeftovers(parent: Folder, pacer: Pacer): Promise<number> {
  let done = 0;
  for (const name of await names(parent)) {
    if (!name.startsWith(TRASH_PREFIX)) continue;
    const tally = await removeTrash(parent, name, pacer);
    if (!tally.partial) done += 1;
  }
  return done;
}

/** Changed in the last RECENT_MS: a download or an install may still be finishing it. */
export const recent = (tally: Tally, now: number) => tally.newest > now - RECENT_MS;
