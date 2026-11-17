import { describe, expect, it } from "vitest";
import { handoffLimits } from "./handoff-limits.ts";

describe("handoffLimits", () => {
  it("defaults to 300 turns per request and 5 failures in a row", () => {
    expect(handoffLimits({})).toEqual({ totalExecutions: 300, failedInARow: 5 });
  });

  it("takes whole numbers from 1 and leaves the default for anything else", () => {
    expect(handoffLimits({ OMB_HANDOFF_MAX_TURNS: "40", OMB_HANDOFF_MAX_FAILURES: " 2 " })).toEqual({ totalExecutions: 40, failedInARow: 2 });
    for (const bad of ["0", "-3", "1.5", "many", "", "Infinity"]) {
      expect(handoffLimits({ OMB_HANDOFF_MAX_TURNS: bad, OMB_HANDOFF_MAX_FAILURES: bad })).toEqual({ totalExecutions: 300, failedInARow: 5 });
    }
  });
});
