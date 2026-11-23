// What the cache sweeper may remove, and how: only folders it knows inside the cache roots Step 6 made, one whole entry
// at a time. Security invariants, each with a test (sweeper.test.ts):
//   - every path comes from the arguments (no HOME or environment read here);
//   - a root is used only when it is exactly the expected `cache` folder, a real folder (no link anywhere on its path past
//     its parent), and neither HOME nor the data folder nor anything holding them;
//   - only a name the tool table (bot-box/tool-caches.ts TOOL_CACHES) or the app list names is ever removed; anything
//     else in a root is measured and reported, never removed;
//   - no link is followed: the walk uses lstat, a unit that is a link or sits under one is refused, and the chmod before
//     a retry touches only real folders;
//   - a unit is walked again just before it goes, and one with anything changed in the last RECENT_MS stays (an install or
//     a download may be writing it);
//   - a bot can write in a tools root while a unit is walked (it is in its box), so the removal is checked again after
//     the walk: the unit's folder and every folder above it are the same ones (device and inode) the check began with,
//     then it is renamed into the data folder's EVICTING_DIR, which no box has, and that is checked to be the unit's own
//     inode, else it is put back and refused; only there is it deleted, so a link a bot swaps in mid-way leads nowhere
//     and a crash leaves a whole entry or a leftover the next sweep finishes, never half an entry.
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, opendir, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { under } from "../bot-box/plan.ts";
import { TOOL_CACHES, TOOL_CACHE_DIR, toolCacheRoot } from "../bot-box/tool-caches.ts";
import { RECENT_MS, TICK_ENTRIES, TICK_PAUSE_MS, YIELD_EVERY } from "./limits.ts";

export type CacheGroup = "tools" | "app";

/** The app's own cache folder in the data folder, which the bot box hides. */
export const APP_CACHE_DIR = "cache";
/** The data folder's folder where a unit waits between its rename and its removal, out of every box's reach (the box
 * hides the data folder); a sweep first removes whatever is left there. */
export const EVICTING_DIR = ".omb-cache-evicting";

/** Folders whose children are the units: a folder named here is never removed whole. Each child the test accepts is a
 * unit (or, when it is itself named here, split again); any other child stays. Every other known folder is one unit. */
const TOOL_SPLITS: Readonly<Record<string, (name: string) => boolean>> = {
  // npm: its content store (_cacache) whole, each npx install (_npx/<hash>) on its own, its logs.
  npm: (name) => !name.startsWith("."),
  "npm/_npx": (name) => !name.startsWith("."),
  // Playwright: one folder per browser build (chromium-1140, ffmpeg-1010); .links records which installs use them.
  "ms-playwright": (name) => !name.startsWith("."),
  // Hugging Face's hub: one folder per repository (models--org--name); .locks and version.txt stay.
  "huggingface/hub": (name) => /^(?:models|datasets|spaces)--/.test(name),
};
/** The app's: Node's compile cache, one folder per Node version and build (cloud-home-start.ts NODE_COMPILE_CACHE). */
const APP_SPLITS: Readonly<Record<string, (name: string) => boolean>> = {
  "node-compile": (name) => !name.startsWith("."),
};
const APP_FOLDERS = ["node-compile"] as const;

export interface RootInput {
  home: string;
  dataDir: string;
  /** A Team Cloud's audience engine homes (engine-homes/layout.ts audienceHomes). */
  audienceHomes: readonly string[];
  /** Step 6's switch (bot-box/tool-caches.ts toolCachesOn): off, no tool cache folder is ours to clean. */
  tools: boolean;
}

/** The roots to look at: each box HOME's `cache` when Step 6 is on, and the data folder's own `cache`. */
export function expectedRoots(input: RootInput): Array<{ group: CacheGroup; path: string }> {
  const tools = input.tools ? [input.home, ...input.audienceHomes].map((home) => ({ group: "tools" as const, path: toolCacheRoot(home) })) : [];
  return [...tools, { group: "app", path: join(resolve(input.dataDir), APP_CACHE_DIR) }];
}

const code = (error: unknown) => (error as NodeJS.ErrnoException)?.code ?? "";

async function realOrNull(path: string): Promise<string | null> {
  try { return await realpath(path); } catch { return null; }
}

/** The root's real path, null when it does not exist, or why it is refused. `forbidden`: HOME and the data folder. */
export async function checkRoot(path: string, forbidden: readonly string[]): Promise<{ real: string } | { refused: string } | null> {
  const full = resolve(path);
  if (basename(full) !== TOOL_CACHE_DIR && basename(full) !== APP_CACHE_DIR) return { refused: "not a cache folder" };
  let stat;
  try { stat = await lstat(full); } catch (error) { return code(error) === "ENOENT" ? null : { refused: `unreadable (${code(error)})` }; }
  if (stat.isSymbolicLink()) return { refused: "a link" };
  if (!stat.isDirectory()) return { refused: "not a folder" };
  const parent = await realOrNull(dirname(full)), real = await realOrNull(full);
  if (!parent || !real || real !== join(parent, basename(full))) return { refused: "not where it is expected" };
  for (const place of forbidden) {
    const other = await realOrNull(place) ?? resolve(place);
    if (under(other, real)) return { refused: "it is or holds HOME or the data folder" };
  }
  return { real };
}

export interface Unit {
  group: CacheGroup;
  /** The root's real path. */
  root: string;
  /** Under the root, with `/` between parts. */
  name: string;
  /** Known: the sweeper may remove it. Unknown: only measured and reported. */
  removable: boolean;
}

const unitPath = (unit: Pick<Unit, "root" | "name">) => join(unit.root, ...unit.name.split("/"));

async function children(path: string): Promise<string[]> {
  try { return (await readdir(path)).sort(); } catch { return []; }
}

/** The units in one root. `keep`: paths that are never units (the running server's own compile cache folder). */
export async function listUnits(group: CacheGroup, root: string, keep: readonly string[] = []): Promise<{ units: Unit[] }> {
  const splits = group === "tools" ? TOOL_SPLITS : APP_SPLITS;
  const known = group === "tools" ? TOOL_CACHES.map((cache) => cache.folder) : [...APP_FOLDERS];
  const kept = new Set(await Promise.all(keep.map(async (path) => await realOrNull(path) ?? resolve(path))));
  const units: Unit[] = [];
  const add = (name: string, removable: boolean) => { if (!kept.has(unitPath({ root, name }))) units.push({ group, root, name, removable }); };
  const split = async (name: string): Promise<void> => {
    const accept = splits[name]!;
    for (const child of await children(unitPath({ root, name }))) {
      const inner = `${name}/${child}`;
      if (splits[inner]) await split(inner);
      else if (accept(child)) add(inner, true);
    }
  };
  for (const folder of known) {
    if (splits[folder]) await split(folder);
    else if (await lstat(unitPath({ root, name: folder })).then(() => true, () => false)) add(folder, true);
  }
  // Anything else at the top of the root, and inside a folder that only holds known ones (huggingface/), is not ours.
  const tops = new Set(known.map((folder) => folder.split("/")[0]!));
  for (const name of await children(root)) if (!tops.has(name)) add(name, false);
  return { units };
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

export interface Measure {
  bytes: number;
  files: number;
  /** The newest change (mtime or ctime) of anything in it, in ms. */
  newest: number;
  /** When it was last used: its newest modification, or its newest access when the mount keeps access times. */
  used: number;
  /** It is a link, or it could not be read: never removed. */
  link?: boolean;
}

/** Walks `path` without following links. `atime`: the mount keeps access times (not noatime). */
export async function measure(path: string, atime: boolean, pacer: Pacer = new Pacer()): Promise<Measure> {
  const result: Measure = { bytes: 0, files: 0, newest: 0, used: 0 };
  const note = (stat: Awaited<ReturnType<typeof lstat>>) => {
    result.bytes += typeof stat.blocks === "number" && stat.blocks > 0 ? Number(stat.blocks) * 512 : Number(stat.size);
    result.files += 1;
    result.newest = Math.max(result.newest, Number(stat.mtimeMs), Number(stat.ctimeMs));
    // A folder's access time moves whenever it is listed, by this walk too: only files' say a tool read them.
    result.used = Math.max(result.used, Number(stat.mtimeMs), atime && !stat.isDirectory() ? Number(stat.atimeMs) : 0);
  };
  let top;
  try { top = await lstat(path); } catch { return { ...result, link: true }; }
  if (top.isSymbolicLink()) return { ...result, link: true };
  note(top);
  const stack = top.isDirectory() ? [path] : [];
  while (stack.length) {
    const dir = stack.pop()!;
    let handle;
    try { handle = await opendir(dir); } catch { continue; }
    for await (const entry of handle) {
      await pacer.step();
      const full = join(dir, entry.name);
      try {
        const stat = await lstat(full);
        note(stat);
        if (stat.isDirectory()) stack.push(full);
      } catch { /* gone while walking */ }
    }
  }
  return result;
}

/** Makes every real folder under `path` writable by its owner, never through a link (Go's module cache is read-only). */
async function makeWritable(path: string): Promise<void> {
  const stack = [path];
  while (stack.length) {
    const dir = stack.pop()!;
    const stat = await lstat(dir).catch(() => null);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) continue;
    await chmod(dir, 0o700).catch(() => {});
    for (const name of await children(dir)) stack.push(join(dir, name));
  }
}

async function removeTree(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    if (code(error) !== "EACCES" && code(error) !== "EPERM") throw error;
    await makeWritable(path);
    await rm(path, { recursive: true, force: true });
  }
}

/** The data folder's EVICTING_DIR, made when missing; null when it is not a real folder there (then nothing is removed). */
export async function evictingDir(dataDir: string): Promise<string | null> {
  const dir = join(resolve(dataDir), EVICTING_DIR);
  await mkdir(dir, { mode: 0o700 }).catch(() => {});
  const stat = await lstat(dir).catch(() => null);
  const parent = await realOrNull(resolve(dataDir));
  return stat?.isDirectory() && !stat.isSymbolicLink() && parent && await realOrNull(dir) === join(parent, EVICTING_DIR) ? dir : null;
}

/** Finishes what an earlier sweep moved into `trash` (evictingDir) and could not delete. */
export async function finishLeftovers(trash: string): Promise<number> {
  let done = 0;
  for (const name of await children(trash)) await removeTree(join(trash, name)).then(() => { done += 1; }, () => {});
  return done;
}

export type Removal = { removed: true; measure: Measure } | { removed: false; reason: "unknown" | "link" | "outside" | "recent" | "gone" | "failed" | "changed"; measure?: Measure };

interface Identity { dev: number; ino: number }
const identity = async (path: string): Promise<Identity | null> => {
  const stat = await lstat(path).catch(() => null);
  return stat && !stat.isSymbolicLink() ? { dev: Number(stat.dev), ino: Number(stat.ino) } : null;
};
const same = (a: Identity | null, b: Identity | null) => a !== null && b !== null && a.dev === b.dev && a.ino === b.ino;

/** The unit's folder and each folder up to its root, by identity; null when any is a link or not where its path says. */
async function chain(root: string, path: string): Promise<Identity[] | null> {
  const ids: Identity[] = [];
  for (let at = path; ; at = dirname(at)) {
    const id = await identity(at);
    if (!id) return null;
    ids.push(id);
    if (at === root) break;
    if (dirname(at) === at) return null;
  }
  return await realOrNull(dirname(path)) === dirname(path) ? ids : null;
}

/** Removes one unit, or says why not. Walks it again first: what was measured an hour ago does not decide. `trash`: the
 * data folder's evictingDir, required for a real removal. */
export async function removeUnit(unit: Unit, options: { now: number; atime: boolean; trash: string | null; pacer?: Pacer; dryRun?: boolean }): Promise<Removal> {
  if (!unit.removable) return { removed: false, reason: "unknown" };
  const path = unitPath(unit);
  const rel = relative(unit.root, path);
  if (!rel || rel.startsWith("..") || rel.split(sep).includes("..")) return { removed: false, reason: "outside" };
  const top = await lstat(path).catch(() => null);
  if (!top) return { removed: false, reason: "gone" };
  if (top.isSymbolicLink()) return { removed: false, reason: "link" };
  // Every folder between the root and the unit is real: a link there would take the removal elsewhere.
  const before = await chain(unit.root, path);
  if (!before) return { removed: false, reason: "outside" };
  const fresh = await measure(path, options.atime, options.pacer);
  if (fresh.link) return { removed: false, reason: "link" };
  if (fresh.newest > options.now - RECENT_MS) return { removed: false, reason: "recent", measure: fresh };
  if (options.dryRun) return { removed: true, measure: fresh };
  if (!options.trash) return { removed: false, reason: "failed", measure: fresh };
  // The walk took time, and a bot may have swapped a folder on the way for a link meanwhile.
  const after = await chain(unit.root, path);
  if (!after || after.length !== before.length || after.some((id, index) => !same(id, before[index]!))) return { removed: false, reason: "changed", measure: fresh };
  const aside = join(options.trash, randomBytes(8).toString("hex"));
  try {
    await rename(path, aside);
  } catch (error) {
    return { removed: false, reason: code(error) === "ENOENT" ? "gone" : "failed", measure: fresh };
  }
  // What moved is the unit itself, or it goes back where it came from, untouched.
  if (!same(await identity(aside), before[0]!)) {
    await rename(aside, path).catch(() => {});
    return { removed: false, reason: "changed", measure: fresh };
  }
  try { await removeTree(aside); } catch { /* the next sweep finishes it (finishLeftovers) */ }
  return { removed: true, measure: fresh };
}
