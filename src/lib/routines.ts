/** Routine wire shapes — the records as they ride the REST snapshot and the
 * `routine` / `routine.run` live frames — live in shared/routines.ts now
 * (part of the wire model); re-exported here so existing client imports keep
 * working. */
export type {
  RoutineIntervalWindow,
  RoutineSchedule,
  RoutineScheduleInput,
  RoutineRunOn,
  RoutineTarget,
  RoutineGoalStatus,
  RoutineContextAttachment,
  RoutineRunTrigger,
  RoutineRunStatus,
  Routine,
  RoutineRun,
  RoutineInput,
} from "../../shared/routines";
export { ROUTINE_PROBLEM_STATUSES, isRoutineProblemRun, type RoutineRunStatusFilter } from "../../shared/routines";
