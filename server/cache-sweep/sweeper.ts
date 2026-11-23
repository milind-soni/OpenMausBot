// The cache cap (docs/bot-box.md, "Tool caches: the cap"): behind OMB_CACHE_SWEEP (off), a background sweeper keeps the
// tools' cache folders together, and the app's own cache folder, each under its cap (limits.ts), removing the least
// recently used whole entries first (units.ts). It never runs while a turn is, never blocks the event loop (async walks
// with a budget per tick), and resumes a measurement where a restart left it. At EMERGENCY_FULL of the volume it empties
// the tools' folders before anything else fails. clearCaches() is the same removal on demand, with a dry run.
// With the switch off nothing is ever deleted: the sweep does not start and clearCaches only counts.
import { readFile, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { cloudRole } from "../bot-box/detect.ts";
import { APP_CAP_ENV, EMERGENCY_BACKOFF_MS, EMERGENCY_FULL, PRESSURE_EVERY_MS, SWEEP_EVERY_MS, TOOL_CAP_ENV, capBytes, cacheSweepOn } from "./limits.ts";
import { Pacer, checkRoot, evictingDir, expectedRoots, finishLeftovers, listUnits, measure, removeUnit, type CacheGroup, type Measure, type Pace, type Unit } from "./units.ts";

export const CACHE_SWEEP_STATE = "cache-sweep.json";
/** A measurement a restarted sweep may reuse for ordering (never for deciding a removal: removeUnit walks again). */
const MEASURE_FRESH_MS = 24 * 60 * 60_000;

export interface CacheSweeperDeps {
  dataDir: string;
  home: string;
  /** The switches and cap overrides (OMB_CACHE_SWEEP, OMB_CACHE_CAP_TOOLS, OMB_CACHE_CAP_APP). */
  env: Record<string, string | undefined>;
  /** Step 6 is on (bot-box/tool-caches.ts toolCachesOn): only then are the tools' cache folders ours. */
  tools: boolean;
  audienceHomes: () => readonly string[];
  /** Paths never removed: the running server's own compile cache folder. */
  keep: () => readonly string[];
  /** Whether the mount holding `root` keeps access times. */
  atimeKept: (root: string) => Promise<boolean>;
  volume: (path: string) => Promise<{ total: number; free: number }>;
  now?: () => number;
  pace?: Pace;
  log?: (line: string) => void;
}

export interface Cleared { count: number; bytes: number; entries: number; at: number | null; reason: string | null }

interface State {
  cleared: Cleared;
  emergency: { count: number; bytes: number; at: number | null };
  lastSweep: { at: number; groups: Partial<Record<CacheGroup, { bytes: number; cap: number; removed: number; freed: number; unknown: number }>> } | null;
  /** The measurement in progress, kept so a restart goes on from it. */
  measured: Record<string, Measure & { at: number }>;
}

export interface ClearResult {
  dryRun: boolean;
  /** Bytes and whole entries removed, or that would be in a dry run. */
  bytes: number;
  entries: number;
  files: number;
  /** Changed in the last RECENT_MS (an install in progress): left. */
  recent: number;
  /** Not ours (unknown names), links, or outside a root: left, and counted. */
  kept: number;
  refusedRoots: Array<{ path: string; reason: string }>;
}

export class CacheSweepOff extends Error {
  constructor() { super("The cache cap is off on this server (OMB_CACHE_SWEEP), so nothing is deleted. A dry run still counts."); }
}

const empty = (): State => ({ cleared: { count: 0, bytes: 0, entries: 0, at: null, reason: null }, emergency: { count: 0, bytes: 0, at: null }, lastSweep: null, measured: {} });

/** Linux: the mount holding `path` is not mounted noatime (relatime keeps them to the day). Elsewhere: no, use mtime. */
export async function mountKeepsAtime(path: string, mountinfo: () => Promise<string> = () => readFile("/proc/self/mountinfo", "utf8")): Promise<boolean> {
  let text: string;
  try { text = await mountinfo(); } catch { return false; }
  let best: { point: string; options: string } | null = null;
  for (const line of text.split("\n")) {
    const fields = line.split(" ");
    const point = fields[4], options = `${fields[5] ?? ""},${fields.slice(fields.indexOf("-") + 3).join(",")}`;
    if (!point || !(path === point || path.startsWith(point.endsWith("/") ? point : `${point}/`))) continue;
    if (!best || point.length > best.point.length) best = { point, options };
  }
  return best !== null && !best.options.split(",").includes("noatime");
}

export async function volumeOf(path: string): Promise<{ total: number; free: number }> {
  const stat = await statfs(path);
  return { total: Number(stat.blocks) * Number(stat.bsize), free: Number(stat.bavail) * Number(stat.bsize) };
}

export function createCacheSweeper(deps: CacheSweeperDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));
  const stateFile = join(deps.dataDir, CACHE_SWEEP_STATE);
  let state: State | null = null;
  let running: Promise<unknown> | null = null;
  const timers: NodeJS.Timeout[] = [];
  const on = () => cacheSweepOn(deps.env);

  const load = async (): Promise<State> => {
    if (state) return state;
    try { state = { ...empty(), ...JSON.parse(await readFile(stateFile, "utf8")) as Partial<State> }; } catch { state = empty(); }
    return state!;
  };
  const save = async () => { if (state) await writeFile(stateFile, JSON.stringify(state)).catch(() => {}); };
  // Read now, so the storage report has the counters without waiting for a pass.
  void load();

  /** The checked roots, and the units in each. */
  const roots = async (scope: "tools" | "app" | "all") => {
    const refused: Array<{ path: string; reason: string }> = [];
    const found: Array<{ group: CacheGroup; real: string; units: Unit[] }> = [];
    const keep = deps.keep();
    for (const root of expectedRoots({ home: deps.home, dataDir: deps.dataDir, audienceHomes: deps.audienceHomes(), tools: deps.tools })) {
      if (scope !== "all" && root.group !== scope) continue;
      const checked = await checkRoot(root.path, [deps.home, deps.dataDir]);
      if (!checked) continue;
      if ("refused" in checked) { refused.push({ path: root.path, reason: checked.refused }); continue; }
      found.push({ group: root.group, real: checked.real, ...await listUnits(root.group, checked.real, keep) });
    }
    for (const refusal of refused) log(`cache sweep: left ${refusal.path} alone: ${refusal.reason}`);
    return { found, refused };
  };

  const atimes = new Map<string, boolean>();
  const atimeFor = async (root: string) => {
    if (!atimes.has(root)) atimes.set(root, await deps.atimeKept(root));
    return atimes.get(root)!;
  };

  const record = async (reason: string, bytes: number, entries: number) => {
    const current = await load();
    current.cleared = { count: current.cleared.count + 1, bytes: current.cleared.bytes + bytes, entries: current.cleared.entries + entries, at: now(), reason };
    await save();
  };

  /** Removes every removable unit of `scope` (or counts them, dry). */
  const clearScope = async (scope: "tools" | "app" | "all", dryRun: boolean, reason: string): Promise<ClearResult> => {
    const { found, refused } = await roots(scope);
    const result: ClearResult = { dryRun, bytes: 0, entries: 0, files: 0, recent: 0, kept: 0, refusedRoots: refused };
    const pacer = new Pacer(deps.pace);
    const trash = dryRun ? null : await evictingDir(deps.dataDir);
    if (trash) await finishLeftovers(trash);
    for (const root of found) {
      for (const unit of root.units) {
        const removal = await removeUnit(unit, { now: now(), atime: await atimeFor(root.real), trash, pacer, dryRun });
        if (removal.removed) { result.bytes += removal.measure.bytes; result.files += removal.measure.files; result.entries += 1; }
        else if (removal.reason === "recent") result.recent += 1;
        else if (removal.reason !== "gone") result.kept += 1;
      }
    }
    if (!dryRun && result.entries > 0) {
      await record(reason, result.bytes, result.entries);
      log(`cache sweep: ${reason} removed ${result.entries} cache entr${result.entries === 1 ? "y" : "ies"}, ${result.bytes} bytes; left ${result.recent} in use`);
    }
    return result;
  };

  /** One full pass: measure every unit (resuming a measurement a restart cut short), then remove the least recently used
   * of each group while it is over its cap. Returns what it did, or why it did not run. */
  const sweep = async (busy: () => boolean = () => false): Promise<{ skipped: string } | NonNullable<State["lastSweep"]>> => {
    if (!on()) return { skipped: "off" };
    if (busy()) return { skipped: "busy" };
    const current = await load();
    const { found } = await roots("all");
    const pacer = new Pacer(deps.pace);
    const volume = await deps.volume(deps.dataDir);
    const sizes = new Map<string, Measure>();
    const trash = await evictingDir(deps.dataDir);
    if (trash) await finishLeftovers(trash);
    for (const root of found) {
      for (const unit of root.units) {
        const key = join(root.real, unit.name);
        const known = current.measured[key];
        if (known && known.at > now() - MEASURE_FRESH_MS) { sizes.set(key, known); continue; }
        if (busy()) { await save(); return { skipped: "busy" }; }
        const measured = await measure(key, await atimeFor(root.real), pacer);
        sizes.set(key, measured);
        current.measured[key] = { ...measured, at: now() };
        await save();
      }
    }
    const groups: NonNullable<State["lastSweep"]>["groups"] = {};
    for (const group of ["tools", "app"] as const) {
      const units = found.filter((root) => root.group === group).flatMap((root) => root.units.map((unit) => ({ unit, root: root.real, size: sizes.get(join(root.real, unit.name))! })));
      if (!units.length) continue;
      const cap = capBytes(volume.total, deps.env[group === "tools" ? TOOL_CAP_ENV : APP_CAP_ENV]);
      let bytes = units.reduce((sum, entry) => sum + entry.size.bytes, 0);
      const summary = { bytes, cap, removed: 0, freed: 0, unknown: units.filter((entry) => !entry.unit.removable).length };
      for (const entry of units.filter((candidate) => candidate.unit.removable).sort((a, b) => a.size.used - b.size.used)) {
        if (bytes <= cap) break;
        if (busy()) break;
        const removal = await removeUnit(entry.unit, { now: now(), atime: await atimeFor(entry.root), trash, pacer });
        if (!removal.removed) continue;
        bytes -= Math.max(entry.size.bytes, removal.measure.bytes);
        summary.removed += 1;
        summary.freed += removal.measure.bytes;
      }
      groups[group] = { ...summary, bytes: Math.max(0, bytes) };
      if (summary.removed) await record(`over the ${group === "tools" ? "tools'" : "app's"} cap`, summary.freed, summary.removed);
    }
    current.lastSweep = { at: now(), groups };
    current.measured = {};
    await save();
    return current.lastSweep;
  };

  /** At EMERGENCY_FULL of the volume, empties the tools' cache folders (every known entry not in use), logged and counted.
   * Not again within EMERGENCY_BACKOFF_MS, so a disk that stays full is not walked every few minutes. */
  const emergency = async (): Promise<ClearResult | { skipped: string }> => {
    if (!on()) return { skipped: "off" };
    const volume = await deps.volume(deps.dataDir);
    if (volume.total <= 0 || 1 - volume.free / volume.total < EMERGENCY_FULL) return { skipped: "room" };
    const current = await load();
    if (current.emergency.at !== null && current.emergency.at > now() - EMERGENCY_BACKOFF_MS) return { skipped: "backoff" };
    log(`cache sweep: the volume is ${Math.round((1 - volume.free / volume.total) * 100)}% full: emptying the tools' cache folders`);
    const result = await clearScope("tools", false, "emergency: volume full");
    current.emergency = { count: current.emergency.count + 1, bytes: current.emergency.bytes + result.bytes, at: now() };
    await save();
    return result;
  };

  /** One at a time: a sweep, the emergency pass and a clear never run together. */
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = (running ?? Promise.resolve()).catch(() => {}).then(work);
    running = next.finally(() => { if (running === next) running = null; });
    return next;
  };

  return {
    sweep: (busy?: () => boolean) => serial(() => sweep(busy)),
    emergency: () => serial(emergency),
    /** The future "Clear cache" button's and an operator's: what goes (or would, `dryRun`), by default a dry run. */
    clearCaches: (options: { dryRun?: boolean; scope?: "tools" | "app" | "all" } = {}): Promise<ClearResult> => {
      const dryRun = options.dryRun !== false;
      if (!dryRun && !on()) return Promise.reject(new CacheSweepOff());
      return serial(() => clearScope(options.scope ?? "all", dryRun, "cleared on request"));
    },
    /** For the storage report and the admin API: the counters, and the last sweep's numbers. */
    /** The counters for the storage report, without waiting: null until the state file is read (at start). */
    counters: (): { cacheCleared: Cleared; emergency: State["emergency"] } | null => (state ? { cacheCleared: state.cleared, emergency: state.emergency } : null),
    /** Only a Cloud home has one: elsewhere the routes answer 404. */
    available: () => cloudRole(deps.env),
    report: async () => {
      const current = await load();
      return { on: on(), tools: deps.tools, cacheCleared: current.cleared, emergency: current.emergency, lastSweep: current.lastSweep };
    },
    /** Starts the hourly sweep and the disk check, when the switch is on; `busy`: a turn is running. */
    start(busy: () => boolean): void {
      if (!on() || timers.length) return;
      const guard = (work: () => Promise<unknown>) => () => { work().catch((error) => log(`cache sweep failed: ${error instanceof Error ? error.message : String(error)}`)); };
      timers.push(setInterval(guard(() => serial(() => sweep(busy))), SWEEP_EVERY_MS), setInterval(guard(() => serial(emergency)), PRESSURE_EVERY_MS));
      timers.push(setTimeout(guard(() => serial(emergency).then(() => serial(() => sweep(busy)))), PRESSURE_EVERY_MS));
      for (const timer of timers) timer.unref();
      log(`cache sweep: on (${deps.tools ? "the tools' cache folders and " : ""}the app's own cache folder)`);
    },
    stop(): void { for (const timer of timers.splice(0)) { clearInterval(timer); clearTimeout(timer); } },
  };
}

export type CacheSweeper = ReturnType<typeof createCacheSweeper>;
