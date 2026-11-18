import type { RoutineRun } from "./routines.ts";

const ACTIVE = new Set<RoutineRun["status"]>(["queued", "running", "waiting"]);

/** Keeps at most `max` run rows. A row that has not ended is never dropped: it owns its run's stop, limit and events.
 * Each row dropped is the oldest ended one of the routine holding the most of them, so a routine that runs every few
 * minutes uses up its own history and not the others'. */
export function evictRuns(runs: RoutineRun[], max: number): void {
  let excess = runs.length - max;
  if (excess <= 0) return;
  const ended = new Map<string, number>();
  for (const run of runs) if (!ACTIVE.has(run.status)) ended.set(run.routineId, (ended.get(run.routineId) ?? 0) + 1);
  for (; excess > 0 && ended.size > 0; excess -= 1) {
    let most = "", held = 0;
    for (const [routineId, count] of ended) if (count > held) [most, held] = [routineId, count];
    runs.splice(runs.findIndex((run) => run.routineId === most && !ACTIVE.has(run.status)), 1);
    if (held === 1) ended.delete(most); else ended.set(most, held - 1);
  }
}
