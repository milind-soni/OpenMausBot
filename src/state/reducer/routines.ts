// Routine and routine-run cases. Case bodies moved verbatim from the reducer switch;
// reducer.ts dispatches each contiguous run to reduceRoutines below.

import type { RoutineRun } from "../../../shared/routines";
import type { Action } from "../action";
import type { AppState } from "../reducer";


const MAX_ROUTINE_RUNS = 2_000;
const ACTIVE_ROUTINE_RUN_STATUSES = new Set<RoutineRun["status"]>(["queued", "running", "waiting"]);

function trimRoutineRuns(runs: readonly RoutineRun[]): RoutineRun[] {
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
export type RoutinesAction = Extract<Action, { type: "routinesHydrated" | "routinesLoadFailed" | "routinePatched" | "routineDeleted" | "routineRunPatched" }>;

export function reduceRoutines(state: AppState, action: RoutinesAction): AppState {
  switch (action.type) {
    case "routinesHydrated":
      return { ...state, routines: action.routines, routineRuns: trimRoutineRuns(action.runs), routinesLoadState: "ready" };
    case "routinesLoadFailed":
      return { ...state, routinesLoadState: "error" };
    case "routinePatched": {
      const exists = state.routines.some((routine) => routine.id === action.routine.id);
      return {
        ...state,
        routines: exists
          ? state.routines.map((routine) => (routine.id === action.routine.id ? action.routine : routine))
          : [action.routine, ...state.routines],
      };
    }
    case "routineDeleted":
      return { ...state, routines: state.routines.filter((routine) => routine.id !== action.routineId) };
    case "routineRunPatched": {
      const exists = state.routineRuns.some((run) => run.id === action.run.id);
      const runs = exists
        ? state.routineRuns.map((run) => (run.id === action.run.id ? action.run : run))
        : [action.run, ...state.routineRuns];
      return {
        ...state,
        routineRuns: trimRoutineRuns(runs),
      };
    }
  }
  return action satisfies never;
}
