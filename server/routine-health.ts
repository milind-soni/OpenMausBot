// What a Cloud home's health report says about each routine, read from the saved run rows every time: failures in a row
// counted in memory would start again from zero at each restart and hide a routine that fails every day.
import { isCountedSkip, type RoutineRunStatus } from "../shared/routines.ts";
import type { Routine, RoutineRun } from "./routines.ts";

/** An id and counts only: nothing of the routine's name, prompt or output. */
export interface RoutineHealth { routineId: string; status: RoutineRunStatus; at: number; consecutiveFailures: number }

const ENDED = new Set<RoutineRunStatus>(["completed", "failed", "missed", "cancelled"]);
const endedAt = (run: RoutineRun) => run.finishedAt ?? run.createdAt;

/** Each routine that is on, and each outside trigger, with a run that ended: its newest ended run, and how many runs in a
 * row before it failed or were missed since the last one that completed (a cancelled run neither counts nor ends the
 * row). A row that only counts occurrences skipped while the routine was at work is no result and is left out, as is a
 * routine that is off or deleted, which is expected to run nothing. Newest first, at most `cap`. */
export function routineHealthOf(routines: readonly Pick<Routine, "id" | "enabled">[], runs: readonly RoutineRun[], cap: number): RoutineHealth[] {
  const on = new Set(routines.filter((routine) => routine.enabled).map((routine) => routine.id));
  const ended = new Map<string, RoutineRun[]>();
  for (const run of runs) {
    if (!ENDED.has(run.status) || isCountedSkip(run) || !(on.has(run.routineId) || run.webhookId === run.routineId)) continue;
    const rows = ended.get(run.routineId);
    if (rows) rows.push(run); else ended.set(run.routineId, [run]);
  }
  const health: RoutineHealth[] = [];
  for (const [routineId, rows] of ended) {
    rows.sort((a, b) => endedAt(b) - endedAt(a) || b.createdAt - a.createdAt);
    let consecutiveFailures = 0;
    for (const run of rows) {
      if (run.status === "completed") break;
      if (run.status !== "cancelled") consecutiveFailures += 1;
    }
    health.push({ routineId, status: rows[0]!.status, at: endedAt(rows[0]!), consecutiveFailures });
  }
  return health.sort((a, b) => b.at - a.at).slice(0, cap);
}
