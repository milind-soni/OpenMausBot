import { describe, expect, it } from "vitest";

import { ROUTINE_GOAL_RUN_LIMIT_MINUTES, ROUTINE_RUN_LIMIT_MINUTES } from "../shared/routines.ts";
import { routineRunLimits } from "./routine-run-limits.ts";

describe("the limit a routine run works under", () => {
  it("is three hours of work, and twelve for a room goal, when the environment says nothing", () => {
    expect(ROUTINE_RUN_LIMIT_MINUTES).toBe(180);
    expect(ROUTINE_GOAL_RUN_LIMIT_MINUTES).toBe(720);
    expect(routineRunLimits({})).toEqual({ runMinutes: 180, goalMinutes: 720 });
  });

  it("is what the environment names, in whole hours", () => {
    expect(routineRunLimits({ OMB_ROUTINE_RUN_LIMIT_HOURS: "6" })).toEqual({ runMinutes: 360, goalMinutes: 720 });
    expect(routineRunLimits({ OMB_ROUTINE_RUN_LIMIT_HOURS: "6", OMB_ROUTINE_GOAL_RUN_LIMIT_HOURS: "18" })).toEqual({ runMinutes: 360, goalMinutes: 1080 });
    expect(routineRunLimits({ OMB_ROUTINE_RUN_LIMIT_HOURS: " 8 " })).toEqual({ runMinutes: 480, goalMinutes: 720 });
  });

  it("keeps the defaults for anything that is not a whole number of hours in range", () => {
    for (const raw of ["0", "-2", "2.5", "25", "six", "", " "]) {
      expect(routineRunLimits({ OMB_ROUTINE_RUN_LIMIT_HOURS: raw })).toEqual({ runMinutes: 180, goalMinutes: 720 });
      expect(routineRunLimits({ OMB_ROUTINE_GOAL_RUN_LIMIT_HOURS: raw })).toEqual({ runMinutes: 180, goalMinutes: 720 });
    }
  });
});
