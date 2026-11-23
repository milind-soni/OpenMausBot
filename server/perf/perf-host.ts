// The server's one performance recorder: turn timings from the bus and the store, the process sampler, rate-limited log
// lines for slow events, and the views the health read, a @devs report and the desktop's diagnostics take from them.
import { join } from "node:path";

import type { EngineLimitsReport } from "../../shared/limit-reset.ts";
import type { RuntimeEvent } from "../contracts.ts";
import type { StoreChange } from "../store.ts";
import { createLoopStalls, requestArrivedBefore, type LoopStalls } from "./loop-stalls.ts";
import { createBotFootprints, type BotCapReport, type BotFootprintReport, type BotFootprints, type FootprintOwner } from "./bot-footprint.ts";
import { duration, limitHolds, perfHealth, perfLines, turnLine, type PerfHealth } from "./perf-report.ts";
import { createDiskUsage, type DiskUsage, type StorageReport } from "./disk-usage.ts";
import { createProcessHealth, type ProcessHealthRecorder } from "./process-health.ts";
import type { ProcessRow } from "./process-buckets.ts";
import { createProcessSampler, linuxProcessList, LINUX_SAMPLE_MS, nodeUtilization, OTHER_SAMPLE_MS, psProcessList, type ProcessSampler } from "./process-sampler.ts";
import { createSetupClock, type SetupClock, type SetupMs } from "./setup-steps.ts";
import type { FailoverWhy } from "./turn-record.ts";
import { createTurnTimings, type Refusal, type SlowNote, type TurnTimings } from "./turn-timings.ts";
import { createLaunchTimings, LAUNCH_FILE, type LaunchTimings } from "./launch-timings.ts";
import { startStallWatch, stallReportLines, type StallWatch } from "./stall-watch.ts";

export const PERF_FILE = "perf-timings.json";
/** The last storage pass and the one under way: under `cache`, which backups leave behind, since they describe this volume only. */
export const STORAGE_FILE = join("cache", "storage-report.json");
export const STORAGE_PROGRESS_FILE = join("cache", "storage-progress.json");

/** The storage sampler's part of the perf host's options: only on a Cloud home, whose HOME is its volume, never on a
 * person's own computer (the desktop app, a self-hosted server). */
export function cloudStorage(cloudHome: unknown, home: string, knownBot: (id: string) => boolean): { storage?: NonNullable<PerfHostDeps["storage"]> } {
  return cloudHome ? { storage: { home, knownBot } } : {};
}
/** One line per kind of slow event at most this often; the ones held back are counted on the next. */
export const LOG_EVERY_MS = 60_000;
const RECENT_IN_REPORT = 10;

export interface PerfHostDeps {
  dataDir: string;
  bus: { subscribe(listener: (event: RuntimeEvent) => void): () => void };
  store: { onChange(listener: (change: StoreChange) => void): () => void; botByThread(threadId: string): { id: string } | null };
  /** The limit clock's report, once it exists. */
  limits?: () => EngineLimitsReport | null | undefined;
  /** A Cloud home's machine is all its own: every process it shows is sampled. Elsewhere only the server's own tree. */
  wholeMachine: boolean;
  log?: (line: string) => void;
  /** Tests: no sampler timer. */
  timer?: false;
  now?: () => number;
  sampler?: ProcessSampler;
  /** Tests: the event-loop delay recorder. */
  stalls?: LoopStalls;
  /** Tests: the process-room recorder. */
  processes?: ProcessHealthRecorder;
  /** The engine processes the server tracks, with the threads each runs (engine-memory, where turns wait for room). */
  engines?: () => ReadonlyArray<{ pid: number; threads: readonly string[] }>;
  /** The engine and browser processes the server started for bots, with the bots each serves (bot-footprint.ts). */
  owners?: () => readonly FootprintOwner[];
  /** After each sample, with its process list: records of exited engines it no longer needs can go. */
  pruneOwners?: (rows: readonly ProcessRow[]) => void;
  /** The memory one bot may use and how it is enforced (bot-memory-cap.ts). */
  cap?: () => BotCapReport;
  /** Watch for main-thread stalls (stall-watch.ts): on a Cloud home and a self-hosted server, not in the desktop app. Never
   * without the sampler timer. */
  watchStalls?: boolean;
  /** The desktop app started this server: its launches are recorded (launch-timings.ts). */
  launches?: Pick<NonNullable<Parameters<typeof createLaunchTimings>[0]>, "launchId" | "counts" | "server">;
  /** A Cloud home, whose HOME is its volume: what fills it is measured (disk-usage.ts). Never a person's own computer. */
  storage?: { home: string; knownBot: (id: string) => boolean };
  /** Tests: the storage sampler. */
  disk?: DiskUsage;
}

/** The health report shows this many bots, the ones using the most memory first; the admin's read shows every one. */
export const BOTS_IN_HEALTH = 10;

/** What a report shows when the recorder failed: diagnostics never fail because of it. */
export const PERF_UNAVAILABLE = ["## Performance", "(timings unavailable: the recorder failed; see the server log)"];

/** A log line per kind at most every LOG_EVERY_MS. */
export function rateLimitedLog(log: (line: string) => void, now: () => number) {
  const last = new Map<string, { at: number; held: number }>();
  return (kind: string, line: string) => {
    const entry = last.get(kind);
    if (entry && now() - entry.at < LOG_EVERY_MS) { entry.held += 1; return; }
    log(`[perf] ${line}${entry?.held ? ` (+${entry.held} more since the last)` : ""}`);
    last.set(kind, { at: now(), held: 0 });
  };
}

export function slowLine(note: SlowNote, now: number): string {
  if (note.kind === "turn") return `slow turn ${turnLine(note.turn)}`;
  if (note.kind === "tool") return `slow tool call: ${note.tool} ${duration(note.ms)} ${note.ok ? "ok" : "failed or left open"} engine ${note.engine ?? "?"} bot ${note.botId ?? "?"} thread ${note.threadId ?? "?"}`;
  return `usage limit refused a turn: engine ${note.engine ?? "?"} scope ${note.scope}${note.resetsAt ? ` resets in ${duration(Math.max(0, note.resetsAt - now))}` : ""}`;
}

export function createPerfHost(deps: PerfHostDeps) {
  const now = deps.now ?? Date.now;
  const say = rateLimitedLog(deps.log ?? ((line) => console.warn(line)), now);
  const timings: TurnTimings = createTurnTimings({
    file: join(deps.dataDir, PERF_FILE), now, botOf: (threadId) => deps.store.botByThread(threadId)?.id ?? null,
    slow: (note) => say(note.kind, slowLine(note, now())),
  });
  const launches: LaunchTimings | null = deps.launches ? createLaunchTimings({ file: join(deps.dataDir, LAUNCH_FILE), now, ...deps.launches }) : null;
  /** Runs `read`, or logs once a minute and returns `fallback`: nothing the recorder does may fail its caller. */
  const guarded = <T>(what: string, read: () => T, fallback: T): T => {
    try { return read(); } catch (error) { say(`failed:${what}`, `the performance recorder failed (${what}): ${error instanceof Error ? error.name : "error"}`); return fallback; }
  };
  deps.store.onChange((change) => { if (change.type === "message") guarded("message", () => timings.noteMessage(change.threadId, change.message, requestArrivedBefore(change.message.at)), undefined); });
  deps.bus.subscribe((event) => guarded("event", () => timings.noteEvent(event), undefined));

  /** The limit clock is made after this host; until it is, there are no limits to read. */
  const limits = () => { try { return deps.limits?.() ?? null; } catch { return null; } };
  let held = new Set<string>();
  const watchHolds = () => {
    const current = new Set(limitHolds(limits()).filter((hold) => hold.blocked).map((hold) => `${hold.driver}:${hold.window ?? "?"}`));
    for (const key of current) if (!held.has(key)) say(`hold:${key}`, `usage limit hold started: ${key}`);
    for (const key of held) if (!current.has(key)) say(`hold:${key}`, `usage limit hold ended: ${key}`);
    held = current;
  };
  const enginePids = () => new Map((deps.engines?.() ?? []).map(({ pid, threads }) => [pid, threads.map(timings.engineOf).find((kind) => kind !== null) ?? "unknown"] as const));
  const linux = process.platform === "linux", windows = process.platform === "win32";
  /** Its two warnings are said once each for the life of the server. */
  const processes = deps.processes ?? createProcessHealth({ warn: (kind, line) => say(kind, line) });
  const footprints: BotFootprints = createBotFootprints({ owners: () => deps.owners?.() ?? [], ...(deps.pruneOwners ? { prune: deps.pruneOwners } : {}), now });
  const botReport = (limit?: number): BotFootprintReport => ({ ...footprints.report(limit), ...(deps.cap ? { cap: deps.cap() } : {}) });
  const sampler = deps.sampler ?? createProcessSampler({
    list: linux ? () => linuxProcessList() : psProcessList, intervalMs: linux ? LINUX_SAMPLE_MS : OTHER_SAMPLE_MS,
    scope: deps.wholeMachine && linux ? "all" : "tree", utilization: nodeUtilization(), now, engines: enginePids,
    stalled: (ms) => say("loop", `event loop stalled: the ${linux ? 60 : 300}s sampler fired ${duration(ms)} late`), afterSample: watchHolds,
    resumed: (ms) => say("sleep", `the computer slept or the server was paused: the ${linux ? 60 : 300}s sampler fired ${duration(ms)} late, not counted as a stall`),
    seen: (rows, buckets) => { processes.sample(rows, buckets); guarded("bots", () => footprints.sample(rows), null); },
  });
  if (deps.timer !== false && !windows) sampler.start();
  const stalls = deps.stalls ?? createLoopStalls({ resumed: (ms) => say("sleep", `the computer slept or the server was paused: the event loop waited through a ${duration(ms)} gap, not counted as a stall`) });
  if (deps.timer !== false) stalls.start();
  const watch: StallWatch | null = deps.timer !== false && deps.watchStalls === true
    ? guarded("stall-watch", () => startStallWatch({ dataDir: deps.dataDir, ...(deps.log ? { log: deps.log } : {}) }), null) : null;
  const caught = () => guarded("stall-watch", () => stallReportLines(watch?.recent() ?? []), []);
  /** Stall records right under the heading: a @devs report keeps only the first lines of this part. */
  const stallsFirst = (lines: string[]) => { const stalls = caught(); return lines[0]?.startsWith("## ") ? [lines[0], ...stalls, ...lines.slice(1)] : [...stalls, ...lines]; };
  const disk: DiskUsage | null = deps.disk ?? (deps.storage ? createDiskUsage({ roots: [{ path: deps.storage.home, scope: "home" }, { path: deps.dataDir, scope: "data" }], volume: deps.storage.home,
    busy: () => timings.running(), knownBot: deps.storage.knownBot, file: join(deps.dataDir, STORAGE_FILE),
    progressFile: join(deps.dataDir, STORAGE_PROGRESS_FILE), now }) : null);
  if (deps.timer !== false) disk?.start();
  if (deps.timer !== false && linux) guarded("limits", () => (deps.log ?? ((line: string) => console.warn(line)))(processes.startLine()), undefined);

  const sources = () => ({ hour: timings.window(), day: timings.day(), live: timings.live(), limits: limits(), process: windows ? null : sampler.report(), stalls: guarded("stalls", () => stalls.report(), null), processes: processes.report(),
    bots: windows ? null : guarded("bots", () => botReport(BOTS_IN_HEALTH), null),
    launches: launches ? guarded("launches", () => ({ stats: launches.stats(), recent: launches.recent() }), null) : null });
  return {
    timings,
    sampler,
    footprints,
    /** Every bot's footprint at the last sample, for the admin's read (routes/perf-diagnostics.ts). */
    bots: (): BotFootprintReport | null => (windows ? null : guarded("bots", () => botReport(), null)),
    noteHeld: (threadId: string, why: "plan-limit" | "memory") => guarded("held", () => timings.noteHeld(threadId, why), undefined),
    noteFailover: (threadId: string, why: FailoverWhy) => guarded("failover", () => timings.noteFailover(threadId, why), undefined),
    noteNotStarted: (threadId: string, turnId: string | null, refusal?: Refusal) => guarded("refused", () => timings.noteNotStarted(threadId, turnId, refusal), undefined),
    /** Times one direct turn's setup; its laps go to `noteSetup` just before the engine is asked. */
    setupClock: (): SetupClock => createSetupClock(),
    noteSetup: (threadId: string, ms: SetupMs) => guarded("setup", () => timings.noteSetup(threadId, ms), undefined),
    /** A part of the app's launch from its main process or its page; null where no app starts this server. */
    noteLaunch: (part: unknown) => (launches ? guarded("launch", () => launches.note(part), { ok: false, complete: false }) : null),
    /** Logs a usage-limit hold that started or ended since the last check; the sampler runs it after each sample. */
    checkHolds: watchHolds,
    health: (): PerfHealth | null => guarded("health", () => perfHealth(sources()), null),
    /** What fills the volume, from the last full pass; null where it is not measured or the report failed. */
    storage: (): StorageReport | null => guarded("storage", () => disk?.report() ?? null, null),
    /** For a @devs report: these conversations' and bots' latest turns, then everything else. */
    lines(filter: { threadIds: readonly string[]; botIds: readonly string[] }): string[] {
      return stallsFirst(guarded("lines", () => perfLines(sources(), timings.recent({ ...filter, limit: RECENT_IN_REPORT }), "Latest turns in this conversation or of its bots, newest last:"), PERF_UNAVAILABLE));
    },
    /** For the desktop's diagnostics export: every bot's latest turns. */
    text(): string {
      return stallsFirst(guarded("text", () => perfLines(sources(), timings.recent({ limit: RECENT_IN_REPORT }), "Latest turns, newest last:"), PERF_UNAVAILABLE)).join("\n");
    },
    /** The graceful shutdown: no more samples, and the turns since the last save written now. */
    stop() { sampler.stop(); stalls.stop(); watch?.stop(); void disk?.stop(); guarded("save", () => timings.flush(), undefined); if (launches) guarded("launch", () => launches.flush(), undefined); },
  };
}
export type PerfHost = ReturnType<typeof createPerfHost>;
