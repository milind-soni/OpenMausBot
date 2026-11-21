import { describe, expect, it } from "vitest";

import { queueLimits } from "./queue-limits.ts";
import { DEFAULT_LIMITS } from "./types.ts";

describe("the queue window", () => {
  it("defaults to half an hour, not a day", () => {
    expect(DEFAULT_LIMITS.queueMs).toBe(30 * 60_000);
    expect(queueLimits({}).queueMs).toBe(30 * 60_000);
  });

  it("takes OMB_QUEUE_TIMEOUT_MINUTES", () => {
    expect(queueLimits({ OMB_QUEUE_TIMEOUT_MINUTES: "5" }).queueMs).toBe(5 * 60_000);
  });

  it("takes OMB_QUEUE_TIMEOUT_MS", () => {
    expect(queueLimits({ OMB_QUEUE_TIMEOUT_MS: "90000" }).queueMs).toBe(90_000);
  });

  it("lets minutes win when both are set", () => {
    expect(queueLimits({ OMB_QUEUE_TIMEOUT_MINUTES: "2", OMB_QUEUE_TIMEOUT_MS: "90000" }).queueMs).toBe(2 * 60_000);
  });

  it("keeps the default for anything that is not a whole number of at least one", () => {
    for (const raw of ["", "  ", "0", "-5", "1.5", "soon", "NaN"]) {
      expect(queueLimits({ OMB_QUEUE_TIMEOUT_MINUTES: raw, OMB_QUEUE_TIMEOUT_MS: raw }).queueMs).toBe(30 * 60_000);
    }
  });
});
