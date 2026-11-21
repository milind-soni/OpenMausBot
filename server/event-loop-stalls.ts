// When this process's event loop was held up. A probe timed out by a stalled loop says nothing about the computer it was
// sent to, so no cloud computer is set aside on probes taken while the loop stalled (server/boat-recovery.ts).
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

/** A delay this long, anywhere in a sample, counts as a stall. */
export const STALL_MS = 2_000;
const SAMPLE_MS = 5_000;
const KEEP_MS = 2 * 60 * 60_000;

export interface EventLoopStalls {
  /** The loop stalled at some point between `from` and `to` (by `now`). */
  stalledBetween(from: number, to: number): boolean;
  close(): void;
}

export function createEventLoopStalls(now: () => number = Date.now, { sampleMs = SAMPLE_MS, stallMs = STALL_MS } = {}): EventLoopStalls {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  /** The end of each sample whose longest delay was a stall, and that delay. */
  const stalls: Array<{ at: number; delayMs: number }> = [];
  let last = performance.now();
  const timer = setInterval(() => {
    // The histogram's longest delay, or this timer's own lateness: the histogram was seen to miss a stall under the test
    // runner, and a late timer cannot.
    const tick = performance.now(), delayMs = Math.max(histogram.max / 1e6, tick - last - sampleMs);
    last = tick;
    histogram.reset();
    const at = now();
    if (delayMs >= stallMs) stalls.push({ at, delayMs });
    while (stalls.length && at - stalls[0]!.at > KEEP_MS) stalls.shift();
  }, sampleMs);
  timer.unref?.();
  return {
    // A sample ending after `from` may hold a stall from up to one sample earlier; that is counted, to be safe.
    stalledBetween: (from, to) => stalls.some((stall) => stall.at >= from && stall.at - stall.delayMs - sampleMs <= to),
    close: () => { clearInterval(timer); histogram.disable(); },
  };
}

let shared: EventLoopStalls | null = null;
/** This process's own, started on first use. */
export const eventLoopStalls = (): EventLoopStalls => (shared ??= createEventLoopStalls());
