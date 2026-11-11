// When routines next need this machine: the desktop's keep-awake (`wakeHold`) and a Cloud home's sleep check
// (server/cloud-power.ts). Pure over RoutineManager's routines and runs.
import type { Routine, RoutineRun } from "./routines.ts";
import { activeMs } from "./routine-waits.ts";

type Due = Pick<Routine, "enabled" | "nextRunAt" | "checks" | "wakeAt" | "checkedAt">;
type Run = Pick<RoutineRun, "status" | "retryAt">;
const startsLater = (run: Run, now: number) => run.status === "queued" && (run.retryAt ?? 0) > now;
/** Every time a run is due: enabled routines' next runs and queued runs' retries. A routine with checks counts only the
 * next time they have something to do on time (`checksDue`). */
const dueTimes = (routines: readonly Due[], runs: readonly Run[], now: number, checksDue: (routine: Due) => number | undefined) =>
  [...routines.filter((routine) => routine.enabled).map((routine) => routine.checks ? checksDue(routine) : routine.nextRunAt),
    ...runs.filter((run) => startsLater(run, now)).map((run) => run.retryAt)].filter((at): at is number => typeof at === "number");

/** The longest a sleeping Cloud home leaves its routines' checks unread. */
export const CHECK_WAKE_MS = 60 * 60_000;
/** On the desktop, plain checks run whenever the computer is awake and never keep it awake. */
const meetingsDue = (routine: Due) => routine.wakeAt;
/** A Cloud home also wakes an hour after the last check, never before the routine's next check. A check that ran without
 * a checked time (trouble, or a run it queued) counts from now, so it can never hold the home awake. */
const cloudChecksDue = (now: number) => (routine: Due) => {
  if (routine.nextRunAt == null || !routine.checks?.length) return routine.wakeAt;
  const hourly = (routine.checkedAt ?? now) + CHECK_WAKE_MS;
  const retried = hourly <= now && routine.nextRunAt > now;
  return Math.min(routine.wakeAt ?? Infinity, Math.max(retried ? now + CHECK_WAKE_MS : hourly, routine.nextRunAt));
};

/** Hold the desktop awake: a run that started (or waits on a person), or one due within the horizon. */
export function wakeHoldOf(routines: readonly Due[], runs: readonly Run[], now: number, horizonMs: number): { hold: boolean; reason?: "running" | "due"; at?: number } {
  if (runs.some((run) => ["queued", "running", "waiting"].includes(run.status) && !startsLater(run, now))) return { hold: true, reason: "running" };
  const due = dueTimes(routines, runs, now, meetingsDue).filter((at) => at <= now + horizonMs).sort((a, b) => a - b)[0];
  return due === undefined ? { hold: false } : { hold: true, reason: "due", at: due };
}

/** A Cloud home's sleep check: a run queued to start now, or running, keeps it awake. One waiting for a person does
 * not: their answer wakes the home. */
export const activeRunsOf = (runs: readonly Run[], now: number) => runs.some((run) => run.status === "running" || (run.status === "queued" && !startsLater(run, now)));

/** The earliest time a run is due; null when none. */
export function nextDueOf(routines: readonly Due[], runs: readonly Run[], now: number): number | null {
  const due = dueTimes(routines, runs, now, cloudChecksDue(now));
  return due.length ? Math.min(...due) : null;
}

type Started = Run & Pick<RoutineRun, "startedAt" | "timeoutMinutes" | "waitedMs" | "asked">;
/** When this process's scheduler next has work: a routine's next run, or its checks once `checksFrom` has passed; a queued
 * run (now, or its retry); a started run reaching its time limit. `skip` leaves out routines whose target is gone. */
export function schedulerDueOf<R extends Due>(routines: readonly R[], runs: readonly Started[], now: number, checksFrom: number, skip: (routine: R) => boolean = () => false): number | null {
  let at = Infinity;
  for (const routine of routines) {
    if (!routine.enabled || skip(routine)) continue;
    const next = Math.min(routine.nextRunAt ?? Infinity, routine.checks ? routine.wakeAt ?? Infinity : Infinity);
    if (next !== Infinity) at = Math.min(at, routine.checks ? Math.max(next, checksFrom) : next);
  }
  for (const run of runs) {
    if (run.status === "queued") at = Math.min(at, run.retryAt ?? now);
    else if ((run.status === "running" || run.status === "waiting") && run.startedAt != null && run.timeoutMinutes != null) {
      at = Math.min(at, now + Math.max(0, run.timeoutMinutes * 60_000 - activeMs(run, now)));
    }
  }
  return at === Infinity ? null : at;
}
