// When this process's event loop was held up. A probe timed out by a stalled loop says nothing about the computer it was
// sent to, so no cloud computer is set aside on probes taken while the loop stalled (server/boat-recovery.ts).
import { performance } from "node:perf_hooks";

/** A delay this long, anywhere in a sample, counts as a stall. */
export const STALL_MS = 2_000;
export const SAMPLE_MS = 5_000;
const KEEP_MS = 2 * 60 * 60_000;
/** How often the loop's own clock ticks; each tick wakes an idle server, so it is far coarser than a stall. Every moment
 * lies in exactly one gap between two looks at the clock (a tick, or a sample reading the gap still open), and nothing
 * ever resets the clock, so a stall of D ms always reads as one gap of between D and D plus this: none is missed, and a
 * hold-up of more than the stall less this (1.5 s) may count as one, which only keeps a computer from being set aside. */
export const LOOP_TIMER_MS = 500;

export interface EventLoopStalls {
  /** The loop stalled at some point between `from` and `to` (by `now`). */
  stalledBetween(from: number, to: number): boolean;
  close(): void;
}

export interface EventLoopStallsOptions {
  sampleMs?: number;
  stallMs?: number;
  tickMs?: number;
  /** Monotonic ms (tests). */
  clock?: () => number;
  /** Calls `run` every `ms` until the returned stop is called (tests); an unref'd setInterval otherwise. */
  every?: (ms: number, run: () => void) => () => void;
}

const everyMs = (ms: number, run: () => void) => {
  const timer = setInterval(run, ms);
  timer.unref?.();
  return () => clearInterval(timer);
};

export function createEventLoopStalls(now: () => number = Date.now, options: EventLoopStallsOptions = {}): EventLoopStalls {
  const { sampleMs = SAMPLE_MS, stallMs = STALL_MS, tickMs = LOOP_TIMER_MS, clock = () => performance.now(), every = everyMs } = options;
  /** The end of each sample whose longest delay was a stall, and that delay. */
  const stalls: Array<{ at: number; delayMs: number }> = [];
  /** The last look at the clock, never cleared, and the longest gap between two looks since the last sample. */
  let lastLook = clock(), longest = 0;
  const look = () => {
    const at = clock();
    longest = Math.max(longest, at - lastLook);
    lastLook = at;
  };
  let lastSample = clock();
  const stopTicks = every(tickMs, look);
  const stopSamples = every(sampleMs, () => {
    // The gap still open counts here (a sample can run before the tick a stall held up), and is closed by this look, so
    // the tick that follows does not count it again. This timer's own lateness stands in for a stall the ticks could not see.
    look();
    const tick = clock(), delayMs = Math.max(longest, tick - lastSample - sampleMs);
    lastSample = tick;
    longest = 0;
    const at = now();
    if (delayMs >= stallMs) stalls.push({ at, delayMs });
    while (stalls.length && at - stalls[0]!.at > KEEP_MS) stalls.shift();
  });
  return {
    // A sample ending after `from` may hold a stall from up to one sample earlier; that is counted, to be safe.
    stalledBetween: (from, to) => stalls.some((stall) => stall.at >= from && stall.at - stall.delayMs - sampleMs <= to),
    close: () => { stopTicks(); stopSamples(); },
  };
}

let shared: EventLoopStalls | null = null;
/** This process's own, started on first use. */
export const eventLoopStalls = (): EventLoopStalls => (shared ??= createEventLoopStalls());
