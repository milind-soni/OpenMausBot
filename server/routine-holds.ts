// Routines that wait while their owner has left (host/routine-holds-host.ts reads why): no AI of theirs is signed in here
// any more, they removed every connected app and MCP server, or the plan was cancelled. A cause that begins turns every routine
// that is on off, stamped with that cause, so its list says why and nothing runs to fail or to message a person who left.
// Once no cause holds a stamped routine it turns back on from now, without the runs it skipped. Turning a routine on or
// off by hand clears its stamp: the person's choice wins, and a later change of cause leaves it alone.
import { ROUTINE_HOLD_CAUSES, type RoutineHoldCause } from "../shared/routines.ts";

export const isRoutineHoldCause = (value: unknown): value is RoutineHoldCause => ROUTINE_HOLD_CAUSES.includes(value as RoutineHoldCause);

/** The causes in their fixed order, each once: the first one holding a routine is the one it shows. */
export function holdCauses(value: unknown): RoutineHoldCause[] {
  return Array.isArray(value) ? ROUTINE_HOLD_CAUSES.filter((cause) => value.includes(cause)) : [];
}

export interface HoldShift<T> {
  /** Routines that were on and are now held: the caller turns each off. */
  paused: T[];
  /** Routines no cause holds any more: the caller turns each back on. */
  resumed: T[];
  /** Causes that began with this change. */
  began: RoutineHoldCause[];
}

export interface AppliedHolds<R, Run> extends HoldShift<R> {
  /** Queued runs of the paused routines, cancelled before they started. */
  cancelled: Run[];
}

type HeldRoutine = { id: string; enabled: boolean; heldFor?: RoutineHoldCause; nextRunAt: number | null; schedule: { type: string } };
type HeldRun = { routineId: string; status: string; attention?: string; finishedAt?: number; error?: string };

/** Turns the routines a change of cause holds off (their queued runs cancelled) and the ones it frees back on from `now`.
 * `next` is the routine's first occurrence from `now`; a one-time run whose time passed while it waited stays over. */
export function applyHolds<R extends HeldRoutine, Run extends HeldRun>(routines: readonly R[], runs: readonly Run[],
  before: readonly RoutineHoldCause[], after: readonly RoutineHoldCause[], now: number, next: (schedule: R["schedule"], now: number) => number | null): AppliedHolds<R, Run> {
  const shift = shiftHolds(routines, before, after);
  for (const routine of shift.paused) Object.assign(routine, { enabled: false, nextRunAt: null });
  for (const routine of shift.resumed) {
    const at = next(routine.schedule, now);
    if (at !== null && (routine.schedule.type !== "once" || at > now)) Object.assign(routine, { enabled: true, nextRunAt: at });
  }
  const paused = new Set(shift.paused.map((routine) => routine.id));
  const cancelled = runs.filter((run) => run.status === "queued" && paused.has(run.routineId));
  for (const run of cancelled) Object.assign(run, { status: "cancelled", attention: undefined, finishedAt: now, error: "The routine was paused before this run started" });
  return { ...shift, cancelled };
}

/** Stamps the routines a change from `before` to `after` holds or frees. A routine held for a cause that ended takes the
 * first cause still holding; one that is on is held for the first cause that began. */
export function shiftHolds<T extends { enabled: boolean; heldFor?: RoutineHoldCause }>(routines: readonly T[], before: readonly RoutineHoldCause[], after: readonly RoutineHoldCause[]): HoldShift<T> {
  const began = after.filter((cause) => !before.includes(cause));
  const shift: HoldShift<T> = { paused: [], resumed: [], began };
  for (const routine of routines) {
    if (routine.heldFor !== undefined && !after.includes(routine.heldFor)) {
      if (after[0]) routine.heldFor = after[0];
      else {
        delete routine.heldFor;
        shift.resumed.push(routine);
      }
    } else if (routine.heldFor === undefined && routine.enabled && began[0]) {
      routine.heldFor = began[0];
      shift.paused.push(routine);
    }
  }
  return shift;
}
