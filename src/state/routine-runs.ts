import type { RoutineRun } from "@/lib/routines";

const MAX_ROUTINE_RUNS = 2_000;
const ACTIVE_ROUTINE_RUN_STATUSES = new Set<RoutineRun["status"]>(["queued", "running", "waiting"]);

export function trimRoutineRuns(runs: readonly RoutineRun[]): RoutineRun[] {
  const sorted = [...runs].sort((a, b) => b.scheduledFor - a.scheduledFor);
  if (sorted.length <= MAX_ROUTINE_RUNS) return sorted;
  const activeCount = sorted.reduce(
    (count, run) => count + (ACTIVE_ROUTINE_RUN_STATUSES.has(run.status) ? 1 : 0),
    0,
  );
  let terminalSlots = Math.max(0, MAX_ROUTINE_RUNS - activeCount);
  return sorted.filter((run) => {
    if (ACTIVE_ROUTINE_RUN_STATUSES.has(run.status)) return true;
    if (terminalSlots === 0) return false;
    terminalSlots -= 1;
    return true;
  });
}

/** The app starts with the runs of the last two weeks (the server adds older ones each automation's status needs); a
 * view that shows older dates loads them. */
export const ROUTINE_RUNS_WINDOW_MS = 14 * 24 * 60 * 60_000;

/** Runs a view loaded on top of those the app holds; what it holds is newer, so it wins. */
export function withOlderRoutineRuns(current: readonly RoutineRun[], loaded: readonly RoutineRun[]): RoutineRun[] {
  const held = new Set(current.map((run) => run.id));
  return trimRoutineRuns([...current, ...loaded.filter((run) => !held.has(run.id))]);
}

/** Where the loaded runs now begin: lower only when the loaded range reaches the window the app holds. */
export function olderRunsSince(since: number | null, loaded: { from?: number; to?: number }): number | null {
  if (since === null || loaded.from === undefined || loaded.to === undefined || loaded.to < since) return since;
  return Math.min(since, loaded.from);
}
