import { describe, expect, it } from "vitest";

import { runtimeLimits } from "./runtime-coordinator.ts";

describe("the limits the coordinator runs the runtime with", () => {
  it("gives a queued assignment half an hour by default", () => {
    expect(runtimeLimits({}).queueMs).toBe(30 * 60_000);
  });

  it("takes the deployment's queue window", () => {
    expect(runtimeLimits({ OMB_QUEUE_TIMEOUT_MINUTES: "5" }).queueMs).toBe(5 * 60_000);
    expect(runtimeLimits({ OMB_QUEUE_TIMEOUT_MS: "45000" }).queueMs).toBe(45_000);
  });

  it("lets the caller ask for a window of its own", () => {
    expect(runtimeLimits({ OMB_QUEUE_TIMEOUT_MINUTES: "5" }, { queueMs: 1_000 }).queueMs).toBe(1_000);
  });
});
