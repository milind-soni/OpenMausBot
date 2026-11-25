// The diagnose read's own look at the volume (server/cloud-diagnose.ts): how many files each kind of folder holds and how old
// its newest and oldest file are, which the storage pass (disk-usage.ts) does not keep. It runs only when the Admin asks, under
// a hard budget: at most `maxEntries` entries, `maxMs` of its own clock and `maxDepth` levels, one file-system call at a time,
// yielding to the event loop every YIELD_EVERY entries, and it stops early (`incomplete`) rather than run long on a nearly
// full, busy Cloud. lstat only: never a link followed, never a file opened, never past the root's filesystem.
// Privacy invariant: it returns category names, fixed bucket names, counts, bytes and times. No name read from the disk.
import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";

import { placeChild, placeStoragePath, type Placement, type StorageCategory, type StorageScope } from "./disk-categories.ts";

export interface DiagnoseStat { dev: number; size: number; blocks?: number; mtimeMs: number; isDirectory(): boolean; isSymbolicLink(): boolean }
export interface DiagnoseDir { read(): Promise<{ name: string } | null>; close(): Promise<void> }
export interface DiagnoseFs { lstat(path: string): Promise<DiagnoseStat>; opendir(path: string): Promise<DiagnoseDir> }
export const nodeDiagnoseFs: DiagnoseFs = { lstat: (path) => lstat(path), opendir: (path) => opendir(path, { bufferSize: 32 }) };

export const DIAGNOSE_WALK_MAX_ENTRIES = 250_000;
export const DIAGNOSE_WALK_MAX_MS = 8_000;
export const DIAGNOSE_WALK_MAX_DEPTH = 24;
/** Entries between two yields to the event loop. */
export const YIELD_EVERY = 256;

/** Finer kinds than the storage categories, matched by fixed folder names only: never a name from the disk in the output. */
export type DiagnoseBucket = StorageCategory | "node_modules" | "task_workspaces" | "downloads";
const DOWNLOADS = new Set(["Downloads", "downloads"]);

export interface BucketTally { bytes: number; files: number; newestAt: number | null; oldestAt: number | null }
export interface DiagnoseWalkResult {
  /** Stopped at a budget before it saw everything. */
  incomplete: boolean;
  /** Which budget stopped it, when one did. */
  stoppedBy: "entries" | "time" | null;
  entries: number;
  tookMs: number;
  /** Folders deeper than maxDepth, counted as one entry each and not entered. */
  tooDeep: number;
  unreadable: number;
  buckets: Array<{ name: DiagnoseBucket } & BucketTally>;
}

export interface DiagnoseWalkOptions {
  fs?: DiagnoseFs;
  now?: () => number;
  maxEntries?: number;
  maxMs?: number;
  maxDepth?: number;
  /** Awaited every YIELD_EVERY entries; a test counts these. */
  yieldNow?: () => Promise<void>;
}

const tally = (): BucketTally => ({ bytes: 0, files: 0, newestAt: null, oldestAt: null });
const bytesOf = (stat: DiagnoseStat) => (typeof stat.blocks === "number" ? stat.blocks * 512 : stat.size);
const fine = (scope: StorageScope, segments: readonly string[], placement: Placement): DiagnoseBucket => {
  if (segments.includes("node_modules")) return "node_modules";
  if (scope === "data" && segments[0] === "task-workspaces") return "task_workspaces";
  if (segments.some((part) => DOWNLOADS.has(part))) return "downloads";
  return placement.category;
};

interface Frame { path: string; segments: string[]; placement: Placement; scope: StorageScope; dev: number; dir: DiagnoseDir | null }

/** Walks `roots` (a root inside another root is walked once, as itself) within the budget. */
export async function diagnoseWalk(roots: ReadonlyArray<{ path: string; scope: StorageScope }>, options: DiagnoseWalkOptions = {}): Promise<DiagnoseWalkResult> {
  const fs = options.fs ?? nodeDiagnoseFs, now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? DIAGNOSE_WALK_MAX_ENTRIES, maxMs = options.maxMs ?? DIAGNOSE_WALK_MAX_MS, maxDepth = options.maxDepth ?? DIAGNOSE_WALK_MAX_DEPTH;
  const yieldNow = options.yieldNow ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  const started = now(), rootPaths = new Set(roots.map((root) => root.path));
  const buckets = new Map<DiagnoseBucket, BucketTally>();
  let entries = 0, tooDeep = 0, unreadable = 0, stoppedBy: DiagnoseWalkResult["stoppedBy"] = null;
  const add = (bucket: DiagnoseBucket, stat: DiagnoseStat, file: boolean) => {
    const row = buckets.get(bucket) ?? buckets.set(bucket, tally()).get(bucket)!;
    row.bytes += bytesOf(stat);
    if (!file) return;
    row.files += 1;
    if (Number.isFinite(stat.mtimeMs)) {
      row.newestAt = row.newestAt === null ? stat.mtimeMs : Math.max(row.newestAt, stat.mtimeMs);
      row.oldestAt = row.oldestAt === null ? stat.mtimeMs : Math.min(row.oldestAt, stat.mtimeMs);
    }
  };
  /** One more entry: false once a budget is spent. */
  const spend = async () => {
    entries += 1;
    if (entries >= maxEntries) { stoppedBy = "entries"; return false; }
    if (entries % YIELD_EVERY === 0) {
      await yieldNow();
      if (now() - started >= maxMs) { stoppedBy = "time"; return false; }
    }
    return true;
  };
  const stack: Frame[] = [];
  const close = async (frame: Frame | undefined) => { if (frame?.dir) { try { await frame.dir.close(); } catch {} frame.dir = null; } };
  try {
    walk: for (const root of roots) {
      let stat: DiagnoseStat;
      try { stat = await fs.lstat(root.path); } catch { unreadable += 1; continue; }
      if (!stat.isDirectory()) continue;
      stack.push({ path: root.path, segments: [], placement: { category: root.scope === "data" ? "settings" : "other", final: false }, scope: root.scope, dev: stat.dev, dir: null });
      while (stack.length) {
        const frame = stack.at(-1)!;
        if (!frame.dir) {
          try { frame.dir = await fs.opendir(frame.path); } catch { unreadable += 1; stack.pop(); continue; }
        }
        let next: { name: string } | null;
        try { next = await frame.dir.read(); } catch { unreadable += 1; next = null; }
        if (!next) { await close(stack.pop()); continue; }
        const path = join(frame.path, next.name);
        if (rootPaths.has(path)) continue;
        const segments = [...frame.segments, next.name];
        let child: DiagnoseStat;
        try { child = await fs.lstat(path); } catch { unreadable += 1; if (!(await spend())) break walk; continue; }
        const directory = child.isDirectory() && !child.isSymbolicLink();
        const placement = frame.segments.length === 0 ? placeStoragePath(frame.scope, segments, directory) : placeChild(frame.placement, frame.scope, segments, directory);
        const bucket = fine(frame.scope, segments, placement);
        add(bucket, child, !directory);
        if (!(await spend())) break walk;
        if (!directory || child.dev !== frame.dev) continue;
        if (segments.length >= maxDepth) { tooDeep += 1; continue; }
        stack.push({ path, segments, placement, scope: frame.scope, dev: frame.dev, dir: null });
      }
    }
  } finally {
    while (stack.length) await close(stack.pop());
  }
  return {
    incomplete: stoppedBy !== null, stoppedBy, entries, tookMs: Math.max(0, now() - started), tooDeep, unreadable,
    buckets: [...buckets.entries()].map(([name, row]) => ({ name, ...row })).filter((row) => row.bytes > 0 || row.files > 0).sort((a, b) => b.bytes - a.bytes),
  };
}
