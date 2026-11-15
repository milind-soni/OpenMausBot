// The server's one performance recorder: turn timings from the bus and the store, the process sampler, rate-limited log
// lines for slow events, and the views the health read, a @devs report and the desktop's diagnostics take from them.
import { join } from "node:path";

import type { EngineLimitsReport } from "../../shared/limit-reset.ts";
import type { RuntimeEvent } from "../contracts.ts";
import type { StoreChange } from "../store.ts";
import { duration, limitHolds, perfHealth, perfLines, turnLine, type PerfHealth } from "./perf-report.ts";
import { createProcessSampler, linuxProcessList, LINUX_SAMPLE_MS, nodeUtilization, OTHER_SAMPLE_MS, psProcessList, type ProcessSampler } from "./process-sampler.ts";
import type { FailoverWhy } from "./turn-record.ts";
import { createTurnTimings, type Refusal, type SlowNote, type TurnTimings } from "./turn-timings.ts";

export const PERF_FILE = "perf-timings.json";
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
  /** The engine processes the server tracks, with the threads each runs (engine-memory, on a Cloud home). */
  engines?: () => ReadonlyArray<{ pid: number; threads: readonly string[] }>;
}

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
  /** Runs `read`, or logs once a minute and returns `fallback`: nothing the recorder does may fail its caller. */
  const guarded = <T>(what: string, read: () => T, fallback: T): T => {
    try { return read(); } catch (error) { say(`failed:${what}`, `the performance recorder failed (${what}): ${error instanceof Error ? error.name : "error"}`); return fallback; }
  };
  deps.store.onChange((change) => { if (change.type === "message") guarded("message", () => timings.noteMessage(change.threadId, change.message), undefined); });
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
  const sampler = deps.sampler ?? createProcessSampler({
    list: linux ? () => linuxProcessList() : psProcessList, intervalMs: linux ? LINUX_SAMPLE_MS : OTHER_SAMPLE_MS,
    scope: deps.wholeMachine && linux ? "all" : "tree", utilization: nodeUtilization(), now, engines: enginePids,
    stalled: (ms) => say("loop", `event loop stalled: the ${linux ? 60 : 300}s sampler fired ${duration(ms)} late`), afterSample: watchHolds,
  });
  if (deps.timer !== false && !windows) sampler.start();

  const sources = () => ({ hour: timings.window(), day: timings.day(), live: timings.live(), limits: limits(), process: windows ? null : sampler.report() });
  return {
    timings,
    sampler,
    noteHeld: (threadId: string, why: "plan-limit" | "memory") => guarded("held", () => timings.noteHeld(threadId, why), undefined),
    noteFailover: (threadId: string, why: FailoverWhy) => guarded("failover", () => timings.noteFailover(threadId, why), undefined),
    noteNotStarted: (threadId: string, turnId: string | null, refusal?: Refusal) => guarded("refused", () => timings.noteNotStarted(threadId, turnId, refusal), undefined),
    /** Logs a usage-limit hold that started or ended since the last check; the sampler runs it after each sample. */
    checkHolds: watchHolds,
    health: (): PerfHealth | null => guarded("health", () => perfHealth(sources()), null),
    /** For a @devs report: these conversations' and bots' latest turns, then everything else. */
    lines(filter: { threadIds: readonly string[]; botIds: readonly string[] }): string[] {
      return guarded("lines", () => perfLines(sources(), timings.recent({ ...filter, limit: RECENT_IN_REPORT }), "Latest turns in this conversation or of its bots, newest last:"), PERF_UNAVAILABLE);
    },
    /** For the desktop's diagnostics export: every bot's latest turns. */
    text(): string {
      return guarded("text", () => perfLines(sources(), timings.recent({ limit: RECENT_IN_REPORT }), "Latest turns, newest last:"), PERF_UNAVAILABLE).join("\n");
    },
    /** The graceful shutdown: no more samples, and the turns since the last save written now. */
    stop() { sampler.stop(); guarded("save", () => timings.flush(), undefined); },
  };
}
export type PerfHost = ReturnType<typeof createPerfHost>;
