// A limit-reset automation's run for a reset that already passed is owed: a usage read in the minute after that reset (the
// limit clock's own, another engine's, a person opening the limits, or the first one after a laptop wakes) already shows
// the next window's reset, or, for a Claude window that has not started again, only the weekly one. Re-timing the
// automation then would skip the run it waited for. routines.ts leaves such an automation alone until that run exists,
// and re-times it after.
import { AFTER_RESET_MS } from "../shared/limit-reset.ts";

interface Timed {
  id: string;
  enabled: boolean;
  nextRunAt: number | null;
  schedule: { type: string };
}

/** The reset this automation was timed for (`nextRunAt` less AFTER_RESET_MS) has passed, and its run has not been made. */
export function limitResetRunOwed(routine: Timed, runs: ReadonlyArray<{ routineId: string; scheduledFor: number }>, now: number): boolean {
  if (!routine.enabled || routine.schedule.type !== "limit_reset" || routine.nextRunAt === null) return false;
  if (routine.nextRunAt - now > AFTER_RESET_MS) return false;
  const due = routine.nextRunAt;
  return !runs.some((run) => run.routineId === routine.id && run.scheduledFor === due);
}
