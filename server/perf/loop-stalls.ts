// How long the event loop could not answer, measured all the time (perf_hooks.monitorEventLoopDelay), and the blocking
// work the server times itself: whole-file saves and runtime-store reads. The process sampler's own "timer late" reads
// one timer once a minute, so it missed 2–3 s stalls a probe saw; this does not. Numbers only, no names or content.
import { AsyncLocalStorage } from "node:async_hooks";
import { monitorEventLoopDelay, performance, type IntervalHistogram } from "node:perf_hooks";

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
interface Minute { count: number; points: Array<[number, number]>; maxMs: number; saves: Tally; runtimeReads: Tally }

export interface StallStats { p50: number; p95: number; p99: number; max: number; over100ms: number; over1s: number }
export interface StallsReport {
  /** The loop's delays over the last minute and the last hour, ms. */
  m1: StallStats | null;
  h1: StallStats | null;
  /** Whole-file saves and runtime-store reads: how many, their total and longest ms. */
  saves: { m1: Tally; h1: Tally };
  runtimeReads: { m1: Tally; h1: Tally };
}

/** The histogram holds the time between its timer's firings: the delay is what exceeds the timer's own interval. */
const lateMs = (ns: number, resolutionMs: number) => Math.max(0, Math.round(ns / 1e5) / 10 - resolutionMs);

function minuteOf(histogram: Pick<IntervalHistogram, "count" | "max" | "percentiles">, tallies: Record<BlockingKind, Tally>, resolutionMs: number): Minute {
  const points = [...histogram.percentiles].map(([percentile, ns]) => [percentile, lateMs(ns, resolutionMs)] as [number, number]).sort((a, b) => a[0] - b[0]);
  return { count: histogram.count, points, maxMs: histogram.count ? lateMs(histogram.max, resolutionMs) : 0, saves: { ...tallies.saves }, runtimeReads: { ...tallies.runtimeReads } };
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

export const STALL_RESOLUTION_MS = 20;
export const MINUTE_MS = 60_000;
const MINUTES_KEPT = 60;

export function createLoopStalls(options: { histogram?: IntervalHistogram; minuteMs?: number; resolutionMs?: number } = {}) {
  const resolutionMs = options.resolutionMs ?? STALL_RESOLUTION_MS;
  const histogram = options.histogram ?? monitorEventLoopDelay({ resolution: resolutionMs });
  const minuteMs = options.minuteMs ?? MINUTE_MS;
  const minutes: Minute[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  const roll = () => {
    minutes.push(minuteOf(histogram, current, resolutionMs));
    if (minutes.length > MINUTES_KEPT) minutes.shift();
    histogram.reset();
    current = { saves: zero(), runtimeReads: zero() };
  };
  return {
    start() {
      if (timer) return;
      histogram.enable();
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
      const live = minuteOf(histogram, current, resolutionMs);
      const last = minutes.at(-1);
      const m1 = last && last.count ? last : live;
      const hour = [...minutes.slice(-(MINUTES_KEPT - 1)), live];
      return {
        m1: stallStats([m1]), h1: stallStats(hour),
        saves: { m1: rounded(m1.saves), h1: rounded(sum(hour.map((minute) => minute.saves))) },
        runtimeReads: { m1: rounded(m1.runtimeReads), h1: rounded(sum(hour.map((minute) => minute.runtimeReads))) },
      };
    },
  };
}
export type LoopStalls = ReturnType<typeof createLoopStalls>;
