// When routines next need this machine: the desktop's keep-awake (`wakeHold`) and a Cloud home's sleep check
// (server/cloud-power.ts). Pure over RoutineManager's routines and runs.
import type { Routine, RoutineRun } from "./routines.ts";

type Due = Pick<Routine, "enabled" | "nextRunAt" | "checks" | "wakeAt">;
type Run = Pick<RoutineRun, "status" | "retryAt">;
const startsLater = (run: Run, now: number) => run.status === "queued" && (run.retryAt ?? 0) > now;
/** Every time a run is due: enabled routines' next runs and queued runs' retries. A routine with checks counts only the
 * next time they have something to do on time: its plain checks run whenever the machine is awake anyway, and never keep
 * it awake or wake it. */
const dueTimes = (routines: readonly Due[], runs: readonly Run[], now: number) => [...routines.filter((routine) => routine.enabled).map((routine) => routine.checks ? routine.wakeAt : routine.nextRunAt),
  ...runs.filter((run) => startsLater(run, now)).map((run) => run.retryAt)].filter((at): at is number => typeof at === "number");

/** Hold the desktop awake: a run that started (or waits on a person), or one due within the horizon. */
export function wakeHoldOf(routines: readonly Due[], runs: readonly Run[], now: number, horizonMs: number): { hold: boolean; reason?: "running" | "due"; at?: number } {
  if (runs.some((run) => ["queued", "running", "waiting"].includes(run.status) && !startsLater(run, now))) return { hold: true, reason: "running" };
  const due = dueTimes(routines, runs, now).filter((at) => at <= now + horizonMs).sort((a, b) => a - b)[0];
  return due === undefined ? { hold: false } : { hold: true, reason: "due", at: due };
}

/** A Cloud home's sleep check: a run queued to start now, or running, keeps it awake. One waiting for a person does
 * not: their answer wakes the home. */
export const activeRunsOf = (runs: readonly Run[], now: number) => runs.some((run) => run.status === "running" || (run.status === "queued" && !startsLater(run, now)));

/** The earliest time a run is due; null when none. */
export function nextDueOf(routines: readonly Due[], runs: readonly Run[], now: number): number | null {
  const due = dueTimes(routines, runs, now);
  return due.length ? Math.min(...due) : null;
}
