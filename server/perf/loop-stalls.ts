// How long the event loop could not answer, measured all the time (perf_hooks.monitorEventLoopDelay), and the blocking
// work the server times itself: whole-file saves and runtime-store reads. The process sampler's own "timer late" reads
// one timer once a minute, so it missed 2–3 s stalls a probe saw; this does not. Numbers only, no names or content. A
// minute whose longest delay the loop only waited through (loop-pause.ts) holds a sleep or a pause, counted apart.
import { AsyncLocalStorage } from "node:async_hooks";
import { monitorEventLoopDelay, performance, type IntervalHistogram } from "node:perf_hooks";

import { loopIdleMs, pausedNotStalled } from "./loop-pause.ts";

export type BlockingKind = "saves" | "runtimeReads";
export interface Tally { n: number; ms: number; maxMs: number }
const zero = (): Tally => ({ n: 0, ms: 0, maxMs: 0 });

let current: Record<BlockingKind, Tally> = { saves: zero(), runtimeReads: zero() };

export function noteBlocking(kind: BlockingKind, ms: number): void {
  const tally = current[kind];
  tally.n += 1;
  tally.ms += ms;
  if (ms > tally.maxMs) tally.maxMs = ms;
}

/** Runs synchronous work that blocks the server and counts its time. */
export function timeBlocking<T>(kind: BlockingKind, run: () => T): T {
  const at = performance.now();
  try {
    return run();
  } finally {
    noteBlocking(kind, performance.now() - at);
  }
}

// When the request a person's message came in on arrived: a turn's queue clock starts there, not after the work the
// server did before storing the message. Set at the top of the request handler for the rest of that request.
const arrival = new AsyncLocalStorage<number>();
export const markRequestArrival = (at = Date.now()): void => arrival.enterWith(at);
/** The current request's arrival, if it came within `withinMs` of `at`. */
export function requestArrivedBefore(at: number, withinMs = 60_000): number | undefined {
  const arrived = arrival.getStore();
  return arrived !== undefined && arrived <= at && at - arrived <= withinMs ? arrived : undefined;
}

/** A distribution as monitorEventLoopDelay gives it: [percentile, delay ms] in rising order, and how many samples. */
interface Minute { count: number; points: Array<[number, number]>; maxMs: number; saves: Tally; runtimeReads: Tally; pauses: Tally }

export interface StallStats { p50: number; p95: number; p99: number; max: number; over100ms: number; over1s: number }
export interface StallsReport {
  /** The loop's delays over the last minute and the last hour, ms. */
  m1: StallStats | null;
  h1: StallStats | null;
  /** Whole-file saves and runtime-store reads: how many, their total and longest ms. */
  saves: { m1: Tally; h1: Tally };
  runtimeReads: { m1: Tally; h1: Tally };
  /** Minutes the computer slept or the server was paused in, kept out of the delays: how many, the gaps' total and longest ms. */
  pauses: { m1: Tally; h1: Tally };
}

/** The histogram holds the time between its timer's firings: the delay is what exceeds the timer's own interval. */
const lateMs = (ns: number, resolutionMs: number) => Math.max(0, Math.round(ns / 1e5) / 10 - resolutionMs);

/** A minute with `pausedMs` set held a sleep or a pause: its delays are left out, since one sample cannot be taken out. */
function minuteOf(histogram: Pick<IntervalHistogram, "count" | "max" | "percentiles">, tallies: Record<BlockingKind, Tally>, resolutionMs: number, pausedMs: number | null): Minute {
  const tallied = { saves: { ...tallies.saves }, runtimeReads: { ...tallies.runtimeReads } };
  if (pausedMs !== null) return { count: 0, points: [], maxMs: 0, ...tallied, pauses: { n: 1, ms: pausedMs, maxMs: pausedMs } };
  const points = [...histogram.percentiles].map(([percentile, ns]) => [percentile, lateMs(ns, resolutionMs)] as [number, number]).sort((a, b) => a[0] - b[0]);
  return { count: histogram.count, points, maxMs: histogram.count ? lateMs(histogram.max, resolutionMs) : 0, ...tallied, pauses: zero() };
}

/** The share of a minute's samples at or under `value`. */
function shareAtOrUnder(minute: Minute, value: number): number {
  let share = 0;
  for (const [percentile, delay] of minute.points) {
    if (delay > value) break;
    share = percentile / 100;
  }
  return share;
}

/** Percentiles over several minutes together, each weighted by its samples: exact to the histograms' own precision. */
export function stallStats(minutes: readonly Minute[]): StallStats | null {
  const used = minutes.filter((minute) => minute.count > 0);
  const total = used.reduce((sum, minute) => sum + minute.count, 0);
  if (!total) return null;
  const values = [...new Set(used.flatMap((minute) => minute.points.map(([, delay]) => delay)))].sort((a, b) => a - b);
  const atOrUnder = (value: number) => used.reduce((sum, minute) => sum + minute.count * shareAtOrUnder(minute, value), 0) / total;
  const quantile = (q: number) => {
    let low = 0, high = values.length - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (atOrUnder(values[mid]!) >= q) high = mid; else low = mid + 1;
    }
    return values[low] ?? 0;
  };
  const over = (value: number) => Math.round(used.reduce((sum, minute) => sum + minute.count * (1 - shareAtOrUnder(minute, value)), 0));
  return { p50: quantile(0.5), p95: quantile(0.95), p99: quantile(0.99), max: Math.max(...used.map((minute) => minute.maxMs)), over100ms: over(100), over1s: over(1000) };
}

const sum = (tallies: readonly Tally[]): Tally => tallies.reduce((all, tally) => ({ n: all.n + tally.n, ms: all.ms + tally.ms, maxMs: Math.max(all.maxMs, tally.maxMs) }), zero());
const rounded = (tally: Tally): Tally => ({ n: tally.n, ms: Math.round(tally.ms), maxMs: Math.round(tally.maxMs * 10) / 10 });

/** How often the histogram's timer fires. Each firing wakes an idle server: at 20 ms that was most of an idle server's CPU
 * (up to about 0.2% of a core on a Fly shared vCPU, 1% under gVisor), every hour of the day. A stall of D ms reads as
 * between D minus this and D: the longest delay reads up to this much short, so a stall just over 1 s (or just over
 * 100 ms) may land under that line in the counts, and a pause's gap reads up to this much short too. The histogram records
 * nothing from a reset to its next firing, so a stall that starts in the first interval after the minute rolls can drop out
 * of the figures. Diagnostics only: nothing acts on these. */
export const STALL_RESOLUTION_MS = 100;
export const MINUTE_MS = 60_000;
const MINUTES_KEPT = 60;

export interface LoopStallsOptions {
  histogram?: IntervalHistogram;
  minuteMs?: number;
  resolutionMs?: number;
  monotonic?: () => number;
  /** The event loop's time spent waiting so far, ms; null where not available. Node's own counter unless `monotonic` is given. */
  idle?: () => number | null;
  /** A minute's longest delay, ms, was a sleep or a pause the loop only waited through: left out of the delays. */
  resumed?: (gapMs: number) => void;
}

export function createLoopStalls(options: LoopStallsOptions = {}) {
  const resolutionMs = options.resolutionMs ?? STALL_RESOLUTION_MS;
  const histogram = options.histogram ?? monitorEventLoopDelay({ resolution: resolutionMs });
  const minuteMs = options.minuteMs ?? MINUTE_MS;
  const monotonic = options.monotonic ?? (() => performance.now());
  const idle = options.idle ?? (options.monotonic ? () => null : loopIdleMs);
  const minutes: Minute[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let since = monotonic(), idleSince = idle(), lastSince = since, lastIdleSince = idleSince;
  /** The minute under way's longest delay when the loop worked less than half of it over this minute and the one before:
   * the delay is recorded on a timer of its own, so a stall the last minute worked through can land in this one. */
  const pausedMs = (): number | null => {
    if (!histogram.count) return null;
    const gap = lateMs(histogram.max, resolutionMs), idleNow = idle();
    return pausedNotStalled(monotonic() - lastSince - gap, gap, idleNow === null || lastIdleSince === null ? null : idleNow - lastIdleSince) ? gap : null;
  };
  const roll = () => {
    const paused = pausedMs();
    minutes.push(minuteOf(histogram, current, resolutionMs, paused));
    if (minutes.length > MINUTES_KEPT) minutes.shift();
    histogram.reset();
    current = { saves: zero(), runtimeReads: zero() };
    [lastSince, lastIdleSince] = [since, idleSince];
    since = monotonic();
    idleSince = idle();
    if (paused !== null) options.resumed?.(Math.round(paused));
  };
  return {
    start() {
      if (timer) return;
      histogram.enable();
      since = lastSince = monotonic();
      idleSince = lastIdleSince = idle();
      timer = setInterval(roll, minuteMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      histogram.disable();
    },
    /** Rolls the minute now (tests). */
    roll,
    /** The last full minute (or the one under way, before the first ends) and the last hour including the minute under way. */
    report(): StallsReport {
      const live = minuteOf(histogram, current, resolutionMs, pausedMs());
      const last = minutes.at(-1);
      const m1 = last && last.count ? last : live;
      const hour = [...minutes.slice(-(MINUTES_KEPT - 1)), live];
      return {
        m1: stallStats([m1]), h1: stallStats(hour),
        saves: { m1: rounded(m1.saves), h1: rounded(sum(hour.map((minute) => minute.saves))) },
        runtimeReads: { m1: rounded(m1.runtimeReads), h1: rounded(sum(hour.map((minute) => minute.runtimeReads))) },
        pauses: { m1: rounded(m1.pauses), h1: rounded(sum(hour.map((minute) => minute.pauses))) },
      };
    },
  };
}
export type LoopStalls = ReturnType<typeof createLoopStalls>;
