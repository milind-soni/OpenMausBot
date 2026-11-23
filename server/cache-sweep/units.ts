// What the cache sweeper may remove, and how: only folders it knows inside the cache roots Step 6 made, one whole entry
// at a time. Security invariants, each with a test (units.test.ts):
//   - every path comes from the arguments (no HOME or environment read here);
//   - a root is used only when it is exactly the expected `cache` folder, a real folder (no link anywhere on its path past
//     its parent), and neither HOME nor the data folder nor anything holding them;
//   - only a name the tool table (bot-box/tool-caches.ts TOOL_CACHES) or the app list names is ever removed; anything
//     else in a root is measured and reported, never removed;
//   - no link is followed: the walk uses lstat, a unit that is a link or sits under one is refused, and the chmod before
//     a retry touches only real folders;
//   - a unit is walked again just before it goes, and one with anything changed in the last RECENT_MS stays (an install or
//     a download may be writing it); it is renamed to a reserved name in its root first, so a crash leaves a whole entry or
//     a leftover the next sweep finishes, never half an entry.
import { randomBytes } from "node:crypto";
import { chmod, lstat, opendir, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { under } from "../bot-box/plan.ts";
import { TOOL_CACHES, TOOL_CACHE_DIR, toolCacheRoot } from "../bot-box/tool-caches.ts";
import { RECENT_MS, TICK_ENTRIES, TICK_PAUSE_MS, YIELD_EVERY } from "./limits.ts";

export type CacheGroup = "tools" | "app";

/** The app's own cache folder in the data folder, which the bot box hides. */
export const APP_CACHE_DIR = "cache";
/** Where a unit waits between its rename and its removal; a sweep removes any it finds first. */
export const EVICTING_PREFIX = ".omb-evicting-";

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
export async function listUnits(group: CacheGroup, root: string, keep: readonly string[] = []): Promise<{ units: Unit[]; leftovers: string[] }> {
  const splits = group === "tools" ? TOOL_SPLITS : APP_SPLITS;
  const known = group === "tools" ? TOOL_CACHES.map((cache) => cache.folder) : [...APP_FOLDERS];
  const kept = new Set(await Promise.all(keep.map(async (path) => await realOrNull(path) ?? resolve(path))));
  const units: Unit[] = [], leftovers: string[] = [];
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
  for (const name of await children(root)) {
    if (name.startsWith(EVICTING_PREFIX)) leftovers.push(join(root, name));
    else if (!tops.has(name)) add(name, false);
  }
  return { units, leftovers };
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
    result.used = Math.max(result.used, Number(stat.mtimeMs), atime ? Number(stat.atimeMs) : 0);
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

/** Finishes what an earlier sweep renamed aside. Only names with EVICTING_PREFIX directly in a checked root. */
export async function finishLeftovers(root: string, leftovers: readonly string[]): Promise<number> {
  let done = 0;
  for (const path of leftovers) {
    if (dirname(path) !== root || !basename(path).startsWith(EVICTING_PREFIX)) continue;
    await removeTree(path).then(() => { done += 1; }, () => {});
  }
  return done;
}

export type Removal = { removed: true; measure: Measure } | { removed: false; reason: "unknown" | "link" | "outside" | "recent" | "gone" | "failed"; measure?: Measure };

/** Removes one unit, or says why not. Walks it again first: what was measured an hour ago does not decide. */
export async function removeUnit(unit: Unit, options: { now: number; atime: boolean; pacer?: Pacer; dryRun?: boolean }): Promise<Removal> {
  if (!unit.removable) return { removed: false, reason: "unknown" };
  const path = unitPath(unit);
  const rel = relative(unit.root, path);
  if (!rel || rel.startsWith("..") || rel.split(sep).includes("..")) return { removed: false, reason: "outside" };
  // Every folder between the root and the unit is real: a link there would take the removal elsewhere.
  if (await realOrNull(dirname(path)) !== dirname(path)) return { removed: false, reason: "outside" };
  const stat = await lstat(path).catch(() => null);
  if (!stat) return { removed: false, reason: "gone" };
  if (stat.isSymbolicLink()) return { removed: false, reason: "link" };
  const fresh = await measure(path, options.atime, options.pacer);
  if (fresh.link) return { removed: false, reason: "link" };
  if (fresh.newest > options.now - RECENT_MS) return { removed: false, reason: "recent", measure: fresh };
  if (options.dryRun) return { removed: true, measure: fresh };
  const aside = join(unit.root, `${EVICTING_PREFIX}${randomBytes(6).toString("hex")}`);
  try {
    await rename(path, aside);
  } catch (error) {
    if (code(error) === "ENOENT") return { removed: false, reason: "gone" };
    return { removed: false, reason: "failed", measure: fresh };
  }
  try { await removeTree(aside); } catch { /* the next sweep finishes it (finishLeftovers) */ }
  return { removed: true, measure: fresh };
}
