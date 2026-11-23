// A walk over the volume that can stop after any entry and go on later: one directory handle per level held between
// steps, one file-system call in flight at a time, lstat only (never a link followed, never a file opened), and never
// past the root's filesystem. Memory: the open levels (at most MAX_DEPTH), the per-bot tallies (at most MAX_BOTS), the
// hard links seen (at most MAX_LINKS inode numbers) and, for going on after a restart, the names already counted in
// the open folders of the top RESUME_DEPTH levels (at most MAX_NAMES names and MAX_NAME_BYTES each).
import { lstat, opendir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { OTHER_NAMES, placeChild, STORAGE_CATEGORIES, type Placement, type StorageCategory, type StorageScope } from "./disk-categories.ts";

export interface WalkStat {
  dev: number; ino: number; nlink: number; size: number; blocks?: number;
  isDirectory(): boolean; isSymbolicLink(): boolean;
}
export interface WalkDir { read(): Promise<{ name: string } | null>; close(): Promise<void> }
export interface WalkFs { lstat(path: string): Promise<WalkStat>; opendir(path: string): Promise<WalkDir> }

export const nodeWalkFs: WalkFs = { lstat: (path) => lstat(path), opendir: (path) => opendir(path, { bufferSize: 32 }) };

export interface WalkRoot { path: string; scope: StorageScope }
export interface Tally { bytes: number; files: number }
export interface WalkSkipped {
  /** Folders and entries that could not be read (permissions, I/O errors). */
  unreadable: number;
  /** Folders on another filesystem (a mount): not walked. */
  otherDevice: number;
  /** Folders deeper than MAX_DEPTH: counted themselves, not walked. */
  tooDeep: number;
  /** Entries deleted between being listed and being read. */
  vanished: number;
  /** Symbolic links: their own size counted, never followed. */
  links: number;
}
export interface WalkTotals {
  categories: Record<StorageCategory, Tally>;
  /** By candidate bot id (disk-categories.ts BOT_FOLDERS). */
  bots: Map<string, Tally>;
  /** Bot folders past MAX_BOTS. */
  botsOverflow: Tally;
  /** Other's first-level names from OTHER_NAMES. */
  otherNamed: Map<string, Tally>;
  /** Other's first-level entries whose names are never reported. */
  otherUnlisted: Tally & { entries: number };
  skipped: WalkSkipped;
  walkedBytes: number;
  entries: number;
  /** More hard-linked files than MAX_LINKS: those past it were counted without the check. */
  linksCapped: boolean;
  /** Bytes of hard-linked files counted past MAX_LINKS, so possibly more than once: at most this much is over-counted. */
  linksUncheckedBytes: number;
  /** Times this pass went on after a restart; hard links are checked again from nothing after each. */
  resumes: number;
}

/** What a pass needs to go on after a restart: the totals so far, the roots finished, and the names counted in each open
 * folder. Taken only between two folders of the top RESUME_DEPTH levels, so nothing counted is outside those names. */
export interface WalkCheckpoint {
  totals: WalkTotals;
  doneRoots: string[];
  frames: Array<{ path: string; names: string[] }>;
}

export const MAX_DEPTH = 64;
export const MAX_BOTS = 5_000;
export const MAX_LINKS = 500_000;
export const RESUME_DEPTH = 4;
export const MAX_NAMES = 5_000;
/** The names one open folder keeps for a checkpoint, in all: a saved pass stays under SAVED_FILE_MAX_BYTES. */
export const MAX_NAME_BYTES = 64 * 1024;
/** A saved pass or report larger than this is never read: it is not one this server wrote. */
export const SAVED_FILE_MAX_BYTES = 1024 * 1024;
/** No byte or file count read back is larger than this (10 PB, the Admin's own bound); a larger one reads as 0. */
export const MAX_COUNT = 1e16;

interface Frame {
  path: string; segments: string[]; placement: Placement; scope: StorageScope; dev: number; dir: WalkDir | null;
  /** Names counted directly in it so far, for a checkpoint; null past MAX_NAMES or MAX_NAME_BYTES, or below the top levels. */
  names: string[] | null;
  nameBytes: number;
  /** Names a resumed pass counted before the restart. */
  skip: ReadonlySet<string> | null;
}

const emptyTally = (): Tally => ({ bytes: 0, files: 0 });

export function emptyTotals(): WalkTotals {
  return {
    categories: Object.fromEntries(Object.keys(STORAGE_CATEGORIES).map((name) => [name, emptyTally()])) as Record<StorageCategory, Tally>,
    bots: new Map(), botsOverflow: emptyTally(), otherNamed: new Map(), otherUnlisted: { ...emptyTally(), entries: 0 },
    skipped: { unreadable: 0, otherDevice: 0, tooDeep: 0, vanished: 0, links: 0 }, walkedBytes: 0, entries: 0, linksCapped: false,
    linksUncheckedBytes: 0, resumes: 0,
  };
}

/** Bytes the entry takes on disk: its allocated blocks where the platform reports them (sparse and tiny files), else its
 * size. Node on Windows reports `blocks` as 0 for every file, so there it is always the size. */
export function allocatedBytes(stat: Pick<WalkStat, "size" | "blocks">, windows = process.platform === "win32"): number {
  const blocks = stat.blocks;
  return !windows && typeof blocks === "number" && Number.isFinite(blocks) && blocks >= 0 ? blocks * 512 : Math.max(0, stat.size);
}

const BOT_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A count read back from a saved file: a finite number from 0 to MAX_COUNT, else 0. */
export const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_COUNT ? value : 0);
const tallyOf = (value: unknown): Tally => ({ bytes: count((value as Tally | null)?.bytes), files: count((value as Tally | null)?.files) });

/** Totals as JSON values (maps as pairs). */
export function totalsJson(totals: WalkTotals): Record<string, unknown> {
  return { ...totals, categories: structuredClone(totals.categories), bots: [...totals.bots].map(([id, tally]) => [id, { ...tally }]),
    otherNamed: [...totals.otherNamed].map(([name, tally]) => [name, { ...tally }]), botsOverflow: { ...totals.botsOverflow },
    otherUnlisted: { ...totals.otherUnlisted }, skipped: { ...totals.skipped } };
}

/** Totals read back field by field: a name that is not a category, a bot-id-shaped id or an allowed other name is dropped,
 * and bots past `maxBots` are added to the overflow. */
export function totalsFrom(value: unknown, maxBots = MAX_BOTS): WalkTotals {
  const totals = (value ?? {}) as Record<string, unknown>;
  const categories = (totals.categories ?? {}) as Record<string, unknown>;
  const overflow = tallyOf(totals.botsOverflow);
  const pairs = (list: unknown, keep: (name: string) => boolean, cap: number) => {
    const kept = new Map<string, Tally>();
    for (const pair of Array.isArray(list) ? list : []) {
      if (!Array.isArray(pair) || typeof pair[0] !== "string" || !keep(pair[0]) || kept.has(pair[0])) continue;
      const tally = tallyOf(pair[1]);
      if (kept.size < cap) kept.set(pair[0], tally);
      else { overflow.bytes += tally.bytes; overflow.files += tally.files; }
    }
    return kept;
  };
  const skipped = (totals.skipped ?? {}) as Record<string, unknown>;
  const unlisted = (totals.otherUnlisted ?? {}) as Record<string, unknown>;
  return {
    categories: Object.fromEntries((Object.keys(STORAGE_CATEGORIES) as StorageCategory[]).map((name) => [name, tallyOf(categories[name])])) as WalkTotals["categories"],
    bots: pairs(totals.bots, (id) => BOT_ID.test(id), maxBots), botsOverflow: overflow,
    otherNamed: pairs(totals.otherNamed, (name) => OTHER_NAMES.has(name), OTHER_NAMES.size), otherUnlisted: { ...tallyOf(unlisted), entries: count(unlisted.entries) },
    skipped: { unreadable: count(skipped.unreadable), otherDevice: count(skipped.otherDevice), tooDeep: count(skipped.tooDeep), vanished: count(skipped.vanished), links: count(skipped.links) },
    walkedBytes: count(totals.walkedBytes), entries: count(totals.entries), linksCapped: totals.linksCapped === true,
    linksUncheckedBytes: count(totals.linksUncheckedBytes), resumes: count(totals.resumes),
  };
}

const NAME = (name: unknown): name is string => typeof name === "string" && name.length > 0 && name.length <= 1024 && !/[\\/\0]/.test(name) && name !== "." && name !== "..";

/** A saved checkpoint, kept only where every path is a root or under one and every name is one folder entry. */
export function checkpointFrom(value: unknown, roots: readonly WalkRoot[]): WalkCheckpoint | null {
  const saved = value as { totals?: unknown; doneRoots?: unknown; frames?: unknown } | null;
  if (!saved || typeof saved !== "object" || !Array.isArray(saved.frames) || !Array.isArray(saved.doneRoots)) return null;
  // Resolved before the check: `<root>/../etc` is not under the root, and a path that resolves elsewhere is not one this server wrote.
  const inRoots = (path: unknown): path is string => typeof path === "string" && resolve(path) === path
    && roots.some((root) => path === root.path || path.startsWith(root.path + sep));
  if (saved.frames.length > RESUME_DEPTH + 1 || !saved.doneRoots.every((path) => roots.some((root) => root.path === path))) return null;
  const frames: WalkCheckpoint["frames"] = [];
  for (const frame of saved.frames as Array<{ path?: unknown; names?: unknown }>) {
    if (!inRoots(frame?.path) || !Array.isArray(frame.names) || frame.names.length > MAX_NAMES || !frame.names.every(NAME)
      || frame.names.reduce((sum, name) => sum + Buffer.byteLength(name) + 3, 0) > MAX_NAME_BYTES) return null;
    frames.push({ path: frame.path, names: [...frame.names] });
  }
  return { totals: totalsFrom(saved.totals), doneRoots: [...saved.doneRoots as string[]], frames };
}

const code = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;

export interface DiskWalkOptions {
  fs?: WalkFs; maxDepth?: number; maxBots?: number; maxLinks?: number;
  /** Goes on from a checkpoint of an earlier walk over the same roots. */
  resume?: WalkCheckpoint | null;
  /** After each folder of the top RESUME_DEPTH levels ends: `take()` gives a checkpoint, or null when one is not possible now. */
  onBoundary?: (take: () => WalkCheckpoint | null) => void;
}

export function createDiskWalk(roots: readonly WalkRoot[], options: DiskWalkOptions = {}) {
  const fs = options.fs ?? nodeWalkFs, maxDepth = options.maxDepth ?? MAX_DEPTH, maxBots = options.maxBots ?? MAX_BOTS, maxLinks = options.maxLinks ?? MAX_LINKS;
  const rootPaths = new Set(roots.map((root) => root.path));
  const resume = options.resume ?? null;
  const doneRoots = [...resume?.doneRoots ?? []];
  const pending = roots.filter((root) => !doneRoots.includes(root.path));
  const stack: Frame[] = [];
  /** Inode numbers of hard-linked files seen, by device. */
  const links = new Map<number, Set<number>>();
  let linkCount = 0;
  const totals: WalkTotals = resume ? { ...resume.totals, resumes: resume.totals.resumes + 1 } : emptyTotals();
  /** Folders whose own blocks the pass counted before the restart, and the names it counted in each. */
  const resumed = new Map((resume?.frames ?? []).map((frame) => [frame.path, new Set(frame.names)]));
  let done = false;

  const add = (placement: Placement, bytes: number, files: number) => {
    totals.categories[placement.category].bytes += bytes;
    totals.categories[placement.category].files += files;
    totals.walkedBytes += bytes;
    if (placement.botId !== undefined) {
      let tally = totals.bots.get(placement.botId);
      if (!tally && totals.bots.size < maxBots) totals.bots.set(placement.botId, tally = emptyTally());
      tally ??= totals.botsOverflow;
      tally.bytes += bytes;
      tally.files += files;
    }
    if (placement.category === "other") {
      const tally = placement.otherName === undefined ? totals.otherUnlisted
        : totals.otherNamed.get(placement.otherName) ?? totals.otherNamed.set(placement.otherName, emptyTally()).get(placement.otherName)!;
      tally.bytes += bytes;
      tally.files += files;
    }
  };
  const missed = (error: unknown) => { if (code(error) === "ENOENT" || code(error) === "ENOTDIR") totals.skipped.vanished += 1; else totals.skipped.unreadable += 1; };
  const counted = (frame: Frame, name: string) => {
    if (!frame.names) return;
    frame.names.push(name);
    frame.nameBytes += Buffer.byteLength(name) + 3;
    if (frame.names.length > MAX_NAMES || frame.nameBytes > MAX_NAME_BYTES) frame.names = null;
  };
  const newFrame = (path: string, segments: string[], placement: Placement, scope: StorageScope, dev: number): Frame => {
    const skip = resumed.get(path) ?? null;
    const names = segments.length < RESUME_DEPTH ? [...skip ?? []] : null;
    return { path, segments, placement, scope, dev, dir: null, names, nameBytes: (names ?? []).reduce((sum, name) => sum + Buffer.byteLength(name) + 3, 0), skip };
  };
  const checkpoint = (): WalkCheckpoint | null => {
    if (!stack.every((frame) => frame.names !== null)) return null;
    return { totals: totalsFrom(totalsJson(totals)), doneRoots: [...doneRoots], frames: stack.map((frame) => ({ path: frame.path, names: [...frame.names!] })) };
  };
  const endFrame = async () => {
    const frame = stack.pop();
    if (!frame) return;
    const dir = frame.dir;
    frame.dir = null;
    if (dir) { try { await dir.close(); } catch {} }
    const parent = stack.at(-1);
    if (frame.segments.length === 0) doneRoots.push(frame.path);
    else if (parent) counted(parent, frame.segments.at(-1)!);
    if (frame.segments.length <= RESUME_DEPTH && options.onBoundary) {
      try { options.onBoundary(checkpoint); } catch {}
    }
  };

  const startRoot = async (root: WalkRoot) => {
    let stat: WalkStat;
    try { stat = await fs.lstat(root.path); } catch (error) { missed(error); return; }
    if (!stat.isDirectory()) return;
    const placement: Placement = { category: root.scope === "data" ? "settings" : "other", final: false };
    if (!resumed.has(root.path)) add(placement, allocatedBytes(stat), 0);
    stack.push(newFrame(root.path, [], placement, root.scope, stat.dev));
  };

  const visit = async (frame: Frame, name: string) => {
    const path = join(frame.path, name);
    if (rootPaths.has(path)) return;
    let stat: WalkStat;
    try { stat = await fs.lstat(path); } catch (error) { missed(error); counted(frame, name); return; }
    const segments = [...frame.segments, name];
    const directory = stat.isDirectory();
    const placement = placeChild(frame.placement, frame.scope, segments, directory);
    const again = resumed.has(path);
    if (segments.length === 1 && placement.category === "other" && placement.otherName === undefined && !again) totals.otherUnlisted.entries += 1;
    if (directory) {
      if (stat.dev !== frame.dev) { totals.skipped.otherDevice += 1; counted(frame, name); return; }
      if (!again) add(placement, allocatedBytes(stat), 0);
      if (segments.length >= maxDepth) { totals.skipped.tooDeep += 1; counted(frame, name); return; }
      stack.push(newFrame(path, segments, placement, frame.scope, frame.dev));
      return;
    }
    counted(frame, name);
    const bytes = allocatedBytes(stat);
    if (stat.isSymbolicLink()) totals.skipped.links += 1;
    else if (stat.nlink > 1) {
      const seen = links.get(stat.dev) ?? links.set(stat.dev, new Set()).get(stat.dev)!;
      if (seen.has(stat.ino)) return;
      if (linkCount < maxLinks) { seen.add(stat.ino); linkCount += 1; } else { totals.linksCapped = true; totals.linksUncheckedBytes += bytes; }
    }
    add(placement, bytes, 1);
  };

  return {
    totals,
    get done() { return done; },
    /** Walks until `entries` entries are read, `stop()` says so (checked before each one) or the walk ends. True when it ended. */
    async step(budget: { entries: number; stop: () => boolean }): Promise<boolean> {
      let read = 0;
      while (!done && read < budget.entries && !budget.stop()) {
        const frame = stack.at(-1);
        if (!frame) {
          const root = pending.shift();
          if (root) await startRoot(root); else done = true;
          continue;
        }
        if (!frame.dir) {
          try { frame.dir = await fs.opendir(frame.path); } catch (error) { missed(error); await endFrame(); continue; }
        }
        let entry: { name: string } | null;
        try { entry = await frame.dir.read(); } catch (error) { missed(error); await endFrame(); continue; }
        if (!entry) { await endFrame(); continue; }
        if (frame.skip?.has(entry.name)) continue;
        read += 1;
        totals.entries += 1;
        await visit(frame, entry.name);
      }
      return done;
    },
    /** Closes every open directory; the walk cannot go on after. */
    async close() {
      done = true;
      pending.length = 0;
      while (stack.length) {
        const dir = stack.pop()!.dir;
        if (dir) { try { await dir.close(); } catch {} }
      }
    },
  };
}
export type DiskWalk = ReturnType<typeof createDiskWalk>;
