// What fills a Cloud home's volume, by category (disk-categories.ts), for the Admin's health read and the owner's
// diagnostics. A pass walks the volume a little at a time (disk-walk.ts): at most TICK_ENTRIES entries or TICK_BUDGET_MS
// every TICK_MS, nothing while a turn runs, one pass soon after boot and then one every PASS_EVERY_MS. Node gives no
// per-call I/O priority and re-nicing would slow the whole server, so the budget is the only throttle. Privacy invariant:
// sizes, counts, fixed category names, ids of bots the store knows and names from OTHER_NAMES; never a file's contents.
import { statfs } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { OTHER_NAMES, STORAGE_CATEGORIES, type StorageCategory, type StorageClass } from "./disk-categories.ts";
import { createDiskWalk, type DiskWalk, type Tally, type WalkFs, type WalkRoot, type WalkSkipped, type WalkTotals } from "./disk-walk.ts";

export const STORAGE_REPORT_VERSION = 1;
/** The health report's `storage` field is at most this many bytes of JSON, apart from `perf`'s own budget. */
export const STORAGE_HEALTH_MAX_BYTES = 4 * 1024;
export const TICK_MS = 2_000;
export const TICK_BUDGET_MS = 25;
export const TICK_ENTRIES = 2_000;
export const PASS_EVERY_MS = 6 * 3_600_000;
export const FIRST_PASS_AFTER_MS = 10 * 60_000;
const BOTS_SHOWN = 10, OTHER_SHOWN = 5;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface VolumeBytes { totalBytes: number; freeBytes: number; usedBytes: number }
export interface StorageCategoryRow { name: StorageCategory; class: StorageClass; bytes: number; files: number }
export interface StorageReport {
  v: typeof STORAGE_REPORT_VERSION;
  /** When the last full pass ended; null before the first. */
  at: number | null;
  ageS: number | null;
  tookS: number | null;
  /** A pass is under way now. */
  running: boolean;
  /** Entries the pass under way has read, and how long it has waited for turns to end. */
  progress: { entries: number; waitedS: number } | null;
  /** The volume when the last pass ended. */
  volume: VolumeBytes | null;
  walkedBytes: number | null;
  /** Used on the volume but not seen by the walk: files held open after deletion, other mounts' roots, metadata. */
  unwalkedBytes: number | null;
  /** The categories with anything in them, the largest first. */
  categories: StorageCategoryRow[];
  /** The bots the store knows, the most bytes first. */
  bots: Array<{ id: string } & Tally>;
  /** The other bot folders: bots not shown, and folders of ids the store does not know. */
  botsRest: Tally & { count: number };
  other: { named: Array<{ name: string } & Tally>; unlisted: Tally & { entries: number } } | null;
  skipped: WalkSkipped | null;
  linksCapped: boolean;
  /** The last pass failed; the figures are from the one before, if any. */
  failed: boolean;
}

interface Completed { at: number; tookMs: number; totals: WalkTotals; volume: VolumeBytes | null }

export interface DiskUsageOptions {
  roots: readonly WalkRoot[];
  /** Any path on the volume, for its total and free bytes. */
  volume: string;
  /** True while a turn runs: no step starts, and a step under way stops at its next entry. */
  busy?: () => boolean;
  /** Whether a bot id is a bot the store knows now. */
  knownBot?: (id: string) => boolean;
  fs?: WalkFs;
  statfs?: (path: string) => Promise<{ blocks: number; bsize: number; bavail: number; bfree: number }>;
  now?: () => number;
  monotonic?: () => number;
  /** Tests: no timer; call `tick()`. */
  timer?: false;
  tickMs?: number;
  tickBudgetMs?: number;
  tickEntries?: number;
  passEveryMs?: number;
  firstPassAfterMs?: number;
  maxDepth?: number;
}

export function createDiskUsage(options: DiskUsageOptions) {
  const now = options.now ?? Date.now, monotonic = options.monotonic ?? (() => performance.now());
  const tickMs = options.tickMs ?? TICK_MS, budgetMs = options.tickBudgetMs ?? TICK_BUDGET_MS, entries = options.tickEntries ?? TICK_ENTRIES;
  const everyMs = options.passEveryMs ?? PASS_EVERY_MS;
  // A data folder that is HOME itself is walked once, as the data folder.
  const roots = [...new Map(options.roots.map((root) => [resolve(root.path), { ...root, path: resolve(root.path) }])).values()];
  const busy = () => { try { return options.busy?.() === true; } catch { return false; } };
  const readVolume = async (): Promise<VolumeBytes | null> => {
    try {
      const stats = await (options.statfs ?? statfs)(options.volume);
      return { totalBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize, usedBytes: (stats.blocks - stats.bfree) * stats.bsize };
    } catch { return null; }
  };
  let dueAt = now() + (options.firstPassAfterMs ?? FIRST_PASS_AFTER_MS);
  let walk: DiskWalk | null = null, pass: { startedAt: number; waitedMs: number; lastTickAt: number } | null = null;
  let last: Completed | null = null, failed = false, ticking = false, stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = () => {
    if (options.timer === false || stopped) return;
    if (timer) clearTimeout(timer);
    const wait = walk ? tickMs : Math.max(tickMs, dueAt - now());
    timer = setTimeout(() => void tick(), wait);
    timer.unref?.();
  };

  async function tick(): Promise<void> {
    if (ticking || stopped) return;
    ticking = true;
    try {
      const at = now();
      if (!walk) {
        if (at < dueAt) return;
        walk = createDiskWalk(roots, { ...(options.fs ? { fs: options.fs } : {}), ...(options.maxDepth ? { maxDepth: options.maxDepth } : {}) });
        pass = { startedAt: at, waitedMs: 0, lastTickAt: at };
      }
      const current = pass!;
      if (busy()) { current.waitedMs += at - current.lastTickAt; current.lastTickAt = at; return; }
      current.lastTickAt = at;
      const started = monotonic();
      const ended = await walk.step({ entries, stop: () => monotonic() - started >= budgetMs || busy() });
      if (ended) {
        last = { at: now(), tookMs: now() - current.startedAt, totals: walk.totals, volume: await readVolume() };
        failed = false;
        walk = null; pass = null;
        dueAt = now() + everyMs;
      }
    } catch {
      await walk?.close().catch(() => {});
      walk = null; pass = null; failed = true;
      dueAt = now() + everyMs;
    } finally {
      ticking = false;
      schedule();
    }
  }

  return {
    start() { if (options.timer !== false && !timer && !stopped) schedule(); },
    async stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; await walk?.close(); walk = null; pass = null; },
    tick,
    /** Starts a pass at the next tick, whatever the schedule says. */
    passNow() { if (!walk) dueAt = now(); },
    running: () => walk !== null,
    report(): StorageReport {
      const at = now();
      const totals = last?.totals;
      const known = (id: string) => ID.test(id) && (() => { try { return options.knownBot?.(id) === true; } catch { return false; } })();
      const bots = [...totals?.bots ?? []].filter(([id]) => known(id)).sort(([, a], [, b]) => b.bytes - a.bytes);
      const shown = bots.slice(0, BOTS_SHOWN);
      const rest = { bytes: 0, files: 0, count: 0 };
      for (const [id, tally] of totals?.bots ?? []) if (!shown.some(([shownId]) => shownId === id)) { rest.bytes += tally.bytes; rest.files += tally.files; rest.count += 1; }
      if (totals) { rest.bytes += totals.botsOverflow.bytes; rest.files += totals.botsOverflow.files; }
      const volume = last?.volume ?? null;
      return {
        v: STORAGE_REPORT_VERSION,
        at: last?.at ?? null,
        ageS: last ? Math.max(0, Math.round((at - last.at) / 1000)) : null,
        tookS: last ? Math.round(last.tookMs / 1000) : null,
        running: walk !== null,
        progress: walk && pass ? { entries: walk.totals.entries, waitedS: Math.round(pass.waitedMs / 1000) } : null,
        volume,
        walkedBytes: totals?.walkedBytes ?? null,
        unwalkedBytes: totals && volume ? Math.max(0, volume.usedBytes - totals.walkedBytes) : null,
        categories: totals ? (Object.keys(STORAGE_CATEGORIES) as StorageCategory[])
          .map((name) => ({ name, class: STORAGE_CATEGORIES[name], ...totals.categories[name] }))
          .filter((row) => row.bytes > 0 || row.files > 0).sort((a, b) => b.bytes - a.bytes) : [],
        bots: shown.map(([id, tally]) => ({ id, ...tally })),
        botsRest: rest,
        other: totals ? {
          named: [...totals.otherNamed].filter(([name]) => OTHER_NAMES.has(name)).sort(([, a], [, b]) => b.bytes - a.bytes).slice(0, OTHER_SHOWN).map(([name, tally]) => ({ name, ...tally })),
          unlisted: { ...totals.otherUnlisted },
        } : null,
        skipped: totals ? { ...totals.skipped } : null,
        linksCapped: totals?.linksCapped ?? false,
        failed,
      };
    },
  };
}
export type DiskUsage = ReturnType<typeof createDiskUsage>;

/** The report as the health read carries it: at most STORAGE_HEALTH_MAX_BYTES, bots and named others dropped first. */
export function storageHealth(report: StorageReport): StorageReport {
  const body = { ...report };
  const size = () => JSON.stringify(body).length;
  const keepBots = (count: number) => {
    const dropped = body.bots.slice(count);
    body.bots = body.bots.slice(0, count);
    body.botsRest = dropped.reduce((rest, bot) => ({ bytes: rest.bytes + bot.bytes, files: rest.files + bot.files, count: rest.count + 1 }), body.botsRest);
  };
  if (size() > STORAGE_HEALTH_MAX_BYTES) keepBots(3);
  if (size() > STORAGE_HEALTH_MAX_BYTES && body.other) body.other = { ...body.other, named: [] };
  if (size() > STORAGE_HEALTH_MAX_BYTES) keepBots(0);
  return body;
}
