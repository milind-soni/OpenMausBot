// The cache cap (docs/bot-box.md, "Tool caches: the cap"): behind OMB_CACHE_SWEEP (off), a background sweeper keeps each
// tools' cache root, and the app's own cache folder, under its cap, removing whole folders, least recently written first
// (units.ts). What makes it safe:
//   - it deletes only through open folders inside a root (tree.ts), from a fixed list of whole tool folders, so it can
//     never reach anything outside the root, whatever a bot swaps in (structural, not a timing guard);
//   - in a tools root it deletes only while no turn runs, no engine is kept warm, and no live process uses that root
//     (in-use.ts), checked again before each folder; a turn that starts while a large folder is being removed may still
//     see it half gone (the tool downloads it again), so this protects running work, it does not guarantee it. A busy
//     home is tried again on the next tick;
//   - the emergency pass at EMERGENCY_FULL and a clear on request obey the same rule: a busy home is left as it is, with
//     one log line (the Admin's disk auto-grow and its alert cover a full disk);
//   - a folder about to go is renamed first, inside its own open parent, and never put back (tree.ts): a later pass
//     finishes what a removal that stopped part-way left.
// With the switch off nothing is read, started or deleted: no state file read, no timer, no routes.
import { readFile, rename, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { APP_CAP_ENV, EMERGENCY_BACKOFF_MS, EMERGENCY_FULL, EMERGENCY_TARGET, SWEEP_EVERY_MS, TICK_EVERY_MS, TOOL_CAP_ENV, capBytes, cacheSweepOn } from "./limits.ts";
import { rootsInUse } from "./in-use.ts";
import { Pacer, anchoredSupported, close, recent, type Folder, type Pace, type Tally } from "./tree.ts";
import { expectedRoots, finishLeftovers, listUnits, measureUnit, openRoot, removeUnit, type CacheGroup, type Root, type Unit } from "./units.ts";

export const CACHE_SWEEP_STATE = "cache-sweep.json";

export interface CacheSweeperDeps {
  dataDir: string;
  home: string;
  /** The switches and cap overrides (OMB_CACHE_SWEEP, OMB_CACHE_CAP_TOOLS, OMB_CACHE_CAP_APP). */
  env: Record<string, string | undefined>;
  /** The tools' cache folders are in use now: their switch is on and the bot box is live (read at every pass). */
  tools: () => boolean;
  audienceHomes: () => readonly string[];
  /** Compile cache folders never removed: the running server's own. */
  keep: () => readonly string[];
  volume: (path: string) => Promise<{ total: number; free: number }>;
  /** The roots a live process uses (in-use.ts rootsInUse). */
  inUse?: (roots: readonly string[]) => Promise<Set<string>>;
  /** Whether this system can delete by open folders (tree.ts); only Linux. */
  supported?: () => boolean;
  now?: () => number;
  /** Reads the state file (a test counts the reads). */
  readText?: (path: string) => Promise<string>;
  pace?: Pace;
  log?: (line: string) => void;
}

export interface Cleared { count: number; bytes: number; entries: number; at: number | null; reason: string | null }
interface RootSummary { group: CacheGroup; bytes: number; cap: number; removed: number; freed: number; tooBig: string[]; busy: boolean }
interface State {
  cleared: Cleared;
  emergency: { count: number; bytes: number; at: number | null };
  lastSweep: { at: number; roots: Record<string, RootSummary> } | null;
}

export interface ClearResult {
  dryRun: boolean;
  /** Bytes and whole folders removed, or that would be in a dry run. */
  bytes: number;
  entries: number;
  files: number;
  /** Written in the last RECENT_MS: left. */
  recent: number;
  /** A tools root a live process uses: nothing in it was removed. */
  busy: number;
  /** Removed only in part (something stayed where it was). */
  partial: number;
  refusedRoots: Array<{ path: string; reason: string }>;
  /** This system cannot delete safely (not Linux): nothing was walked. */
  unsupported?: true;
}

export class CacheSweepOff extends Error {
  constructor() { super("The cache cap is off on this server (OMB_CACHE_SWEEP), so nothing is deleted."); }
}

const empty = (): State => ({ cleared: { count: 0, bytes: 0, entries: 0, at: null, reason: null }, emergency: { count: 0, bytes: 0, at: null }, lastSweep: null });
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
const time = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** The state file's counters, whatever shape it has: anything unreadable is a fresh start for that part. */
export function parseState(text: string): State {
  let raw: Record<string, unknown>;
  try { raw = record(JSON.parse(text)); } catch { return empty(); }
  const cleared = record(raw.cleared), emergency = record(raw.emergency), last = record(raw.lastSweep);
  return {
    cleared: { count: count(cleared.count), bytes: count(cleared.bytes), entries: count(cleared.entries), at: time(cleared.at), reason: typeof cleared.reason === "string" ? cleared.reason : null },
    emergency: { count: count(emergency.count), bytes: count(emergency.bytes), at: time(emergency.at) },
    lastSweep: time(last.at) === null ? null : { at: time(last.at)!, roots: record(last.roots) as Record<string, RootSummary> },
  };
}

export async function volumeOf(path: string): Promise<{ total: number; free: number }> {
  const stat = await statfs(path);
  return { total: Number(stat.blocks) * Number(stat.bsize), free: Number(stat.bavail) * Number(stat.bsize) };
}

const usedShare = (volume: { total: number; free: number }) => (volume.total > 0 ? 1 - volume.free / volume.total : 0);

export function createCacheSweeper(deps: CacheSweeperDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));
  const inUse = deps.inUse ?? ((roots: readonly string[]) => rootsInUse(roots, {
    unreadable: (pid) => once("unreadable", `cache sweep: process ${pid}, which the server started, cannot be read, so no tool cache is removed while such a process runs (said once)`),
    using: (pid, root) => once(`using:${root}`, `cache sweep: process ${pid} uses ${root}, so nothing there is removed while a process does (said once)`),
  }));
  const supported = deps.supported ?? (() => anchoredSupported());
  const stateFile = join(deps.dataDir, CACHE_SWEEP_STATE);
  const on = () => cacheSweepOn(deps.env);
  let state: State | null = null;
  let running: Promise<unknown> | null = null;
  let timer: NodeJS.Timeout | null = null;
  /** A turn runs or an engine is kept warm (start-upkeep.ts). Until the sweeper is started, the home counts as busy. */
  let globalBusy: () => boolean = () => true;
  let busyLoggedAt: number | null = null;
  /** When the emergency pass last measured, so a disk that stays full is not walked again every tick. */
  let emergencyTriedAt: number | null = null;
  let loading: Promise<State> | null = null;
  const said = new Set<string>();
  /** A time from the state file, or null when it is later than now (a clock that went back must not hold a pass off). */
  const past = (at: number | null) => (at !== null && at <= now() ? at : null);
  const once = (key: string, line: string) => { if (!said.has(key)) { said.add(key); log(line); } };

  const load = (): Promise<State> => {
    loading ??= (deps.readText ?? ((path: string) => readFile(path, "utf8")))(stateFile).catch(() => "").then((text) => (state = parseState(text)));
    return loading;
  };
  const save = async () => {
    if (!state) return;
    const temporary = `${stateFile}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(state)).then(() => rename(temporary, stateFile)).catch((error: unknown) => log(`cache sweep: could not save ${CACHE_SWEEP_STATE}: ${error instanceof Error ? error.message : String(error)}`));
  };
  const counted = async (reason: string, bytes: number, entries: number) => {
    const current = await load();
    current.cleared = { count: current.cleared.count + 1, bytes: current.cleared.bytes + bytes, entries: current.cleared.entries + entries, at: now(), reason };
    await save();
  };

  /** The open roots of `scope`. The caller closes them. */
  const openRoots = async (scope: "tools" | "app" | "all") => {
    const opened: Array<{ root: Root; folder: Folder }> = [];
    const refused: Array<{ path: string; reason: string }> = [];
    for (const root of expectedRoots({ home: deps.home, dataDir: deps.dataDir, audienceHomes: deps.audienceHomes(), tools: deps.tools() })) {
      if (scope !== "all" && root.group !== scope) continue;
      const result = await openRoot(root, [deps.home, deps.dataDir]);
      if (!result) continue;
      if ("refused" in result) { refused.push({ path: root.path, reason: result.refused }); once(`refused:${root.path}`, `cache sweep: left ${root.path} alone: ${result.refused}`); continue; }
      opened.push({ root, folder: result.folder });
    }
    return { opened, refused };
  };
  const closeAll = async (opened: ReadonlyArray<{ folder: Folder }>) => { for (const { folder } of opened) await close(folder); };

  /** A tools root may be deleted in only while nothing is alive that could write it or run from it. */
  const busy = async (root: Root): Promise<boolean> => root.group === "tools" && (globalBusy() || (await inUse([root.path])).has(root.path));

  const measured = async (root: Root, folder: Folder, pacer: Pacer) => {
    const entries: Array<{ unit: Unit; tally: Tally }> = [];
    for (const unit of await listUnits(root, folder, deps.keep())) {
      const tally = await measureUnit(folder, unit, pacer);
      if (tally) entries.push({ unit, tally });
    }
    return entries;
  };
  const oldestFirst = (entries: ReadonlyArray<{ unit: Unit; tally: Tally }>) =>
    entries.filter((entry) => !recent(entry.tally, now())).sort((a, b) => a.tally.newest - b.tally.newest);

  /** One pass over every root: the folders that alone exceed their root's cap are left (and logged) and not counted; the
   * rest are removed, least recently written first, while the root is over its cap. A busy tools root is not touched. */
  const sweep = async (): Promise<{ skipped: string } | NonNullable<State["lastSweep"]> & { busy: boolean }> => {
    if (!on()) return { skipped: "off" };
    if (!supported()) { once("unsupported", "cache sweep: deleting by open folders needs Linux; nothing is removed here"); return { skipped: "unsupported" }; }
    if (globalBusy()) return { skipped: "busy" };
    const current = await load();
    const { opened } = await openRoots("all");
    const pacer = new Pacer(deps.pace);
    const roots: Record<string, RootSummary> = {};
    let anyBusy = false;
    try {
      const volume = await deps.volume(deps.dataDir);
      const toolRoots = opened.filter((entry) => entry.root.group === "tools").length;
      for (const { root, folder } of opened) {
        // The tools' cap is shared evenly by a Team Cloud's audiences, so one member's caches never push out another's.
        const cap = root.group === "tools" ? Math.floor(capBytes(volume.total, deps.env[TOOL_CAP_ENV]) / Math.max(1, toolRoots)) : capBytes(volume.total, deps.env[APP_CAP_ENV]);
        const summary: RootSummary = { group: root.group, bytes: 0, cap, removed: 0, freed: 0, tooBig: [], busy: false };
        roots[root.path] = summary;
        if (await busy(root)) { summary.busy = anyBusy = true; continue; }
        await finishLeftovers(root, folder, pacer);
        const entries = await measured(root, folder, pacer);
        const fits = entries.filter((entry) => {
          if (entry.tally.bytes <= cap) return true;
          summary.tooBig.push(entry.unit.name);
          once(`too-big:${root.path}/${entry.unit.name}`, `cache sweep: ${root.path}/${entry.unit.name} alone is ${entry.tally.bytes} bytes, over the cap of ${cap}: left as it is (a clear removes it)`);
          return false;
        });
        let bytes = fits.reduce((sum, entry) => sum + entry.tally.bytes, 0);
        for (const entry of oldestFirst(fits)) {
          if (bytes <= cap) break;
          if (await busy(root)) { summary.busy = anyBusy = true; break; }
          const removed = await removeUnit(folder, entry.unit, pacer);
          if (!removed) continue;
          bytes -= entry.tally.bytes;
          summary.removed += 1;
          summary.freed += removed.bytes;
          if (removed.partial) log(`cache sweep: ${root.path}/${entry.unit.name} was removed only in part; what stayed is left where it is`);
        }
        summary.bytes = Math.max(0, bytes);
        if (summary.removed) await counted(`over the ${root.group === "tools" ? "tools'" : "app's"} cap`, summary.freed, summary.removed);
      }
    } finally {
      await closeAll(opened);
    }
    const result = { at: now(), roots };
    // A busy root's pass is not done: the next tick tries again.
    if (!anyBusy) { current.lastSweep = result; await save(); }
    return { ...result, busy: anyBusy };
  };

  /** At EMERGENCY_FULL of the volume, removes the tools' folders, least recently written first, until it is under
   * EMERGENCY_TARGET; never in a root that is busy. */
  const emergency = async (): Promise<ClearResult | { skipped: string }> => {
    if (!on()) return { skipped: "off" };
    if (!supported()) return { skipped: "unsupported" };
    const volume = await deps.volume(deps.dataDir);
    const full = usedShare(volume);
    if (full < EMERGENCY_FULL) return { skipped: "room" };
    const current = await load();
    const last = Math.max(past(current.emergency.at) ?? -Infinity, emergencyTriedAt ?? -Infinity);
    if (last > now() - EMERGENCY_BACKOFF_MS) return { skipped: "backoff" };
    const { opened, refused } = await openRoots("tools");
    const result: ClearResult = { dryRun: false, bytes: 0, entries: 0, files: 0, recent: 0, busy: 0, partial: 0, refusedRoots: refused };
    const pacer = new Pacer(deps.pace);
    try {
      const queue: Array<{ root: Root; folder: Folder; unit: Unit; tally: Tally }> = [];
      for (const { root, folder } of opened) {
        if (await busy(root)) { result.busy += 1; continue; }
        await finishLeftovers(root, folder, pacer);
        for (const entry of await measured(root, folder, pacer)) queue.push({ root, folder, ...entry });
        emergencyTriedAt = now();
      }
      result.recent = queue.filter((entry) => recent(entry.tally, now())).length;
      for (const entry of oldestFirst(queue) as typeof queue) {
        if (usedShare(await deps.volume(deps.dataDir)) < EMERGENCY_TARGET) break;
        if (await busy(entry.root)) { result.busy += 1; break; }
        const removed = await removeUnit(entry.folder, entry.unit, pacer);
        if (!removed) continue;
        result.entries += 1; result.bytes += removed.bytes; result.files += removed.files;
        if (removed.partial) result.partial += 1;
      }
    } finally {
      await closeAll(opened);
    }
    if (result.entries > 0) {
      log(`cache sweep: the volume was ${Math.round(full * 100)}% full: removed ${result.entries} tool cache folder(s), ${result.bytes} bytes`);
      current.emergency = { count: current.emergency.count + 1, bytes: current.emergency.bytes + result.bytes, at: now() };
      await counted("emergency: volume full", result.bytes, result.entries);
    } else if (result.busy > 0 && (busyLoggedAt === null || busyLoggedAt <= now() - EMERGENCY_BACKOFF_MS)) {
      busyLoggedAt = now();
      log(`cache sweep: the volume is ${Math.round(full * 100)}% full, but a bot is working, so no cache was removed`);
    }
    return result;
  };

  /** Removes every unit of `scope` (or counts them, dry); a busy tools root is left whole. */
  const clearScope = async (scope: "tools" | "app" | "all", dryRun: boolean): Promise<ClearResult> => {
    const result: ClearResult = { dryRun, bytes: 0, entries: 0, files: 0, recent: 0, busy: 0, partial: 0, refusedRoots: [] };
    if (!supported()) return { ...result, unsupported: true };
    const { opened, refused } = await openRoots(scope);
    result.refusedRoots = refused;
    const pacer = new Pacer(deps.pace);
    try {
      for (const { root, folder } of opened) {
        if (!dryRun && await busy(root)) { result.busy += 1; continue; }
        if (!dryRun) await finishLeftovers(root, folder, pacer);
        for (const { unit, tally } of await measured(root, folder, pacer)) {
          if (recent(tally, now())) { result.recent += 1; continue; }
          if (!dryRun && await busy(root)) { result.busy += 1; break; }
          const removed = dryRun ? tally : await removeUnit(folder, unit, pacer);
          if (!removed) continue;
          result.entries += 1; result.bytes += removed.bytes; result.files += removed.files;
          if (removed.partial) result.partial += 1;
        }
      }
    } finally {
      await closeAll(opened);
    }
    if (!dryRun && result.entries > 0) {
      await counted("cleared on request", result.bytes, result.entries);
      log(`cache sweep: cleared on request: ${result.entries} cache folder(s), ${result.bytes} bytes`);
    }
    if (!dryRun && result.busy > 0) log("cache sweep: a clear left the caches a bot is working with as they are");
    return result;
  };

  /** One at a time: a sweep, the emergency pass and a clear never run together. */
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = (running ?? Promise.resolve()).catch(() => {}).then(work);
    running = next.finally(() => { if (running === next) running = null; });
    return next;
  };

  /** The tick: the emergency pass, then a sweep that is due (hourly) or that a busy home put off. */
  const tick = async () => {
    await emergency();
    const last = past((await load()).lastSweep?.at ?? null);
    if (last === null || last <= now() - SWEEP_EVERY_MS) await sweep();
  };

  return {
    sweep: () => serial(sweep),
    emergency: () => serial(emergency),
    tick: () => serial(tick),
    /** An operator's, and the future "Clear cache" button's: what goes (or would, `dryRun`), by default a dry run. */
    clearCaches: (options: { dryRun?: boolean; scope?: "tools" | "app" | "all" } = {}): Promise<ClearResult> => {
      const dryRun = options.dryRun !== false;
      if (!on()) return Promise.reject(new CacheSweepOff());
      return serial(() => clearScope(options.scope ?? "all", dryRun));
    },
    /** The counters for the storage report, without waiting: null until the state file is read (after start). */
    counters: (): { cacheCleared: Cleared; emergency: State["emergency"] } | null => (state ? { cacheCleared: state.cleared, emergency: state.emergency } : null),
    /** The routes are there only with the switch on. */
    available: () => on(),
    report: async () => {
      const current = await load();
      return { on: on(), tools: deps.tools(), cacheCleared: current.cleared, emergency: current.emergency, lastSweep: current.lastSweep };
    },
    /** Starts the tick, when the switch is on. `busy`: a turn runs or an engine is kept warm. Called once the server
     * answers (start-upkeep.ts); the first tick is TICK_EVERY_MS later. */
    start(busyNow: () => boolean): void {
      if (!on() || timer) return;
      globalBusy = busyNow;
      void load();
      timer = setInterval(() => { serial(tick).catch((error: unknown) => log(`cache sweep failed: ${error instanceof Error ? error.message : String(error)}`)); }, TICK_EVERY_MS);
      timer.unref();
      log(`cache sweep: on (${deps.tools() ? "the tools' cache folders and " : ""}the app's own cache folder)`);
    },
    stop(): void { if (timer) clearInterval(timer); timer = null; },
  };
}

export type CacheSweeper = ReturnType<typeof createCacheSweeper>;
