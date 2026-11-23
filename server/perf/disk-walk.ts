// A walk over the volume that can stop after any entry and go on later: one directory handle per level held between
// steps, one file-system call in flight at a time, lstat only (never a link followed, never a file opened), and never
// past the root's filesystem. Memory: the open levels (at most MAX_DEPTH), the per-bot tallies (at most MAX_BOTS) and the
// hard links seen (at most MAX_LINKS).
import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";

import { placeChild, STORAGE_CATEGORIES, type Placement, type StorageCategory, type StorageScope } from "./disk-categories.ts";

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
  /** More hard links than MAX_LINKS: those past it may be counted more than once. */
  linksCapped: boolean;
}

export const MAX_DEPTH = 64;
export const MAX_BOTS = 5_000;
export const MAX_LINKS = 50_000;

interface Frame { path: string; segments: string[]; placement: Placement; scope: StorageScope; dev: number; dir: WalkDir | null }

const emptyTally = (): Tally => ({ bytes: 0, files: 0 });

/** Bytes the entry takes on disk: allocated blocks where the platform reports them (sparse and tiny files), else its size. */
export function allocatedBytes(stat: Pick<WalkStat, "size" | "blocks">): number {
  const blocks = stat.blocks;
  return typeof blocks === "number" && Number.isFinite(blocks) && blocks >= 0 && (blocks > 0 || stat.size === 0) ? blocks * 512 : Math.max(0, stat.size);
}

const code = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;

export function createDiskWalk(roots: readonly WalkRoot[], options: { fs?: WalkFs; maxDepth?: number; maxBots?: number; maxLinks?: number } = {}) {
  const fs = options.fs ?? nodeWalkFs, maxDepth = options.maxDepth ?? MAX_DEPTH, maxBots = options.maxBots ?? MAX_BOTS, maxLinks = options.maxLinks ?? MAX_LINKS;
  const rootPaths = new Set(roots.map((root) => root.path));
  const pending = [...roots];
  const stack: Frame[] = [];
  const links = new Set<string>();
  const totals: WalkTotals = {
    categories: Object.fromEntries(Object.keys(STORAGE_CATEGORIES).map((name) => [name, emptyTally()])) as Record<StorageCategory, Tally>,
    bots: new Map(), botsOverflow: emptyTally(), otherNamed: new Map(), otherUnlisted: { ...emptyTally(), entries: 0 },
    skipped: { unreadable: 0, otherDevice: 0, tooDeep: 0, vanished: 0, links: 0 }, walkedBytes: 0, entries: 0, linksCapped: false,
  };
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
  const closeFrame = async (frame: Frame | undefined) => {
    const dir = frame?.dir;
    if (!frame || !dir) return;
    frame.dir = null;
    try { await dir.close(); } catch {}
  };

  const startRoot = async (root: WalkRoot) => {
    let stat: WalkStat;
    try { stat = await fs.lstat(root.path); } catch (error) { missed(error); return; }
    if (!stat.isDirectory()) return;
    const placement: Placement = { category: root.scope === "data" ? "settings" : "other", final: false };
    add(placement, allocatedBytes(stat), 0);
    stack.push({ path: root.path, segments: [], placement, scope: root.scope, dev: stat.dev, dir: null });
  };

  const visit = async (frame: Frame, name: string) => {
    const path = join(frame.path, name);
    if (rootPaths.has(path)) return;
    let stat: WalkStat;
    try { stat = await fs.lstat(path); } catch (error) { missed(error); return; }
    const segments = [...frame.segments, name];
    const directory = stat.isDirectory();
    const placement = placeChild(frame.placement, frame.scope, segments, directory);
    if (segments.length === 1 && placement.category === "other" && placement.otherName === undefined) totals.otherUnlisted.entries += 1;
    if (directory) {
      if (stat.dev !== frame.dev) { totals.skipped.otherDevice += 1; return; }
      add(placement, allocatedBytes(stat), 0);
      if (segments.length >= maxDepth) { totals.skipped.tooDeep += 1; return; }
      stack.push({ path, segments, placement, scope: frame.scope, dev: frame.dev, dir: null });
      return;
    }
    if (stat.isSymbolicLink()) totals.skipped.links += 1;
    else if (stat.nlink > 1) {
      const key = `${stat.dev}:${stat.ino}`;
      if (links.has(key)) return;
      if (links.size < maxLinks) links.add(key); else totals.linksCapped = true;
    }
    add(placement, allocatedBytes(stat), 1);
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
          try { frame.dir = await fs.opendir(frame.path); } catch (error) { missed(error); stack.pop(); continue; }
        }
        let entry: { name: string } | null;
        try { entry = await frame.dir.read(); } catch (error) { missed(error); await closeFrame(stack.pop()); continue; }
        if (!entry) { await closeFrame(stack.pop()); continue; }
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
      while (stack.length) await closeFrame(stack.pop());
    },
  };
}
export type DiskWalk = ReturnType<typeof createDiskWalk>;
