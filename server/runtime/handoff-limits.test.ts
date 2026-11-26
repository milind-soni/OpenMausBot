import { describe, expect, it } from "vitest";
import { handoffLimits } from "./handoff-limits.ts";

const quiet = { handoffQuietNoticeMs: 20 * 60_000, handoffQuietMaxMs: 60 * 60_000 };

describe("handoffLimits", () => {
  it("defaults to 300 turns per request, 5 failures in a row, a notice at 20 quiet minutes and a stop at 60", () => {
    expect(handoffLimits({})).toEqual({ totalExecutions: 300, failedInARow: 5, ...quiet });
  });

  it("takes whole numbers from 1 and leaves the default for anything else", () => {
    expect(handoffLimits({ OMB_HANDOFF_MAX_TURNS: "40", OMB_HANDOFF_MAX_FAILURES: " 2 ", OMB_HANDOFF_QUIET_NOTICE_MINUTES: "5", OMB_HANDOFF_QUIET_MAX_MINUTES: "90" }))
      .toEqual({ totalExecutions: 40, failedInARow: 2, handoffQuietNoticeMs: 5 * 60_000, handoffQuietMaxMs: 90 * 60_000 });
    for (const bad of ["0", "-3", "1.5", "many", "", "Infinity"]) {
      expect(handoffLimits({ OMB_HANDOFF_MAX_TURNS: bad, OMB_HANDOFF_MAX_FAILURES: bad, OMB_HANDOFF_QUIET_NOTICE_MINUTES: bad, OMB_HANDOFF_QUIET_MAX_MINUTES: bad }))
        .toEqual({ totalExecutions: 300, failedInARow: 5, ...quiet });
    }
  });
});
