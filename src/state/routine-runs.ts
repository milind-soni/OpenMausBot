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
