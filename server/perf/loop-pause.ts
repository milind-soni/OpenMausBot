// A gap the event loop only waited through was not the server's: the computer slept or the process was paused.
import { performance } from "node:perf_hooks";

export const LATE_TIMER_MS = 2_000;

/** A timer `lateMs` overdue was held up by the loop only if the loop worked through that lateness. `waitedMs` is how
 * long the loop sat waiting since the timer was set `intervalMs` ago; null where that is not known. */
export function pausedNotStalled(intervalMs: number, lateMs: number, waitedMs: number | null): boolean {
  if (waitedMs === null || lateMs < LATE_TIMER_MS) return false;
  const workedMs = Math.max(0, intervalMs + lateMs - waitedMs);
  return workedMs < lateMs / 2;
}

/** Node's count of the time the event loop spent waiting so far, ms. */
export const loopIdleMs = (): number => performance.eventLoopUtilization().idle;
