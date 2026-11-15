// When the limit clock (limit-resets.ts) reads plan usage again on its own, while an engine is held or a limit-reset
// automation waits. While turns run, every five minutes, as before. On a quiet home or a closed laptop nobody needs a
// fresher answer than that: it reads once just after each reset it knows of (so a hold ends, and a waiting automation
// is re-timed, on fresh usage) and otherwise once an hour, which still catches a limit that reset early. Someone who
// looks at the limits gets a read at once (LimitResetClock.ensureFresh), whatever this says.
import { AFTER_RESET_MS } from "../shared/limit-reset.ts";

/** How fresh usage is kept while turns run, and how fresh a shown limit must be. */
export const LIMIT_POLL_MS = 5 * 60_000;
/** A turn event this recent counts as the home being in use. */
export const LIMIT_ACTIVE_MS = 15 * 60_000;
/** With nothing running, the most usage goes unread while something holds or waits. */
export const LIMIT_IDLE_POLL_MS = 60 * 60_000;
/** A known reset is read this long after its time, a minute after the automation waiting for it starts. A read that
 * lands sooner (another window's, a person's, the first after a wake) leaves an automation still owed a run for this
 * reset where it is too (limit-reset-owed.ts); the new window re-times it once that run was made. */
export const RESET_READ_AFTER_MS = AFTER_RESET_MS + 60_000;

export interface LimitReadState {
  now: number;
  /** When usage was last read (0: never). */
  checkedAt: number;
  /** The last runtime event of any turn, on any engine. */
  lastTurnAt: number;
  /** The reset times known now: the holds' and the usage windows'. */
  resets: readonly number[];
  /** Reads in a row that failed (no account answered, or the read threw); 0 after one that worked. */
  failures?: number;
}

/** After a failed read on a quiet home, the next comes this long later, doubled after each further failure, at most hourly. */
export function retryAfterFailureMs(failures: number): number {
  return Math.min(LIMIT_POLL_MS * 2 ** Math.max(0, failures - 1), LIMIT_IDLE_POLL_MS);
}

/** Whether the clock's minute tick reads usage now. Called only while an engine is held or an automation waits. */
export function limitReadDue({ now, checkedAt, lastTurnAt, resets, failures = 0 }: LimitReadState): boolean {
  const age = now - checkedAt;
  // The clock was set back past the last read: nothing measured from it holds, so read now and start again from there.
  if (age < 0) return true;
  if (now - lastTurnAt < LIMIT_ACTIVE_MS) return age >= LIMIT_POLL_MS - 1_000;
  if (resets.some((reset) => checkedAt < reset + RESET_READ_AFTER_MS && reset + RESET_READ_AFTER_MS <= now)) return true;
  return age >= (failures > 0 ? retryAfterFailureMs(failures) : LIMIT_IDLE_POLL_MS);
}
