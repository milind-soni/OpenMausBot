// The limit a routine run works under when its routine sets no limit of its own: three hours of work for a bot's
// run, and twelve for a room goal's, which stays running across every member's turn. A server whose routines run
// longer may raise them (OMB_ROUTINE_RUN_LIMIT_HOURS, OMB_ROUTINE_GOAL_RUN_LIMIT_HOURS); a routine that sets a
// limit of its own keeps it, so the environment moves only the runs that set none.
import { ROUTINE_GOAL_RUN_LIMIT_MINUTES, ROUTINE_RUN_LIMIT_MINUTES, type RoutineRunLimits } from "../shared/routines.ts";
import { envWhole } from "./env-limits.ts";

/** The longest limit the environment may name, in hours: the longest a routine may set for itself (1,440 minutes). */
export const RUN_LIMIT_HOURS_MAX = 24;

/** The hours the environment names, or the default: a whole number of hours, never more than the longest limit a
 * routine may set for itself. */
const limitHours = (raw: string | undefined, fallback: number): number => {
  const hours = envWhole(raw, fallback, 1);
  return hours <= RUN_LIMIT_HOURS_MAX ? hours : fallback;
};

/** OMB_ROUTINE_RUN_LIMIT_HOURS and OMB_ROUTINE_GOAL_RUN_LIMIT_HOURS: whole hours from 1 to 24, as a routine's own
 * limit may be; anything else leaves the default. */
export function routineRunLimits(env: NodeJS.ProcessEnv = process.env): RoutineRunLimits {
  return {
    runMinutes: limitHours(env.OMB_ROUTINE_RUN_LIMIT_HOURS, ROUTINE_RUN_LIMIT_MINUTES / 60) * 60,
    goalMinutes: limitHours(env.OMB_ROUTINE_GOAL_RUN_LIMIT_HOURS, ROUTINE_GOAL_RUN_LIMIT_MINUTES / 60) * 60,
  };
}
