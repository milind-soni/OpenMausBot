import { describe, expect, it } from "vitest";

import { webhookActivationDefaults, webhookMaxPendingRunsInput } from "./webhooks.js";

describe("webhookActivationDefaults", () => {
  it("makes a newly created local webhook executable on its first request", () => {
    expect(webhookActivationDefaults()).toEqual({ enabled: true, verificationPending: false });
  });

  it("preserves the activation state while editing an existing webhook", () => {
    expect(webhookActivationDefaults({ enabled: false, verificationPending: true })).toEqual({
      enabled: false,
      verificationPending: true,
    });
  });
});

describe("webhookMaxPendingRunsInput", () => {
  it("reads blank as the default and a whole number from 1 to 50 as the limit", () => {
    expect(webhookMaxPendingRunsInput("")).toBeNull();
    expect(webhookMaxPendingRunsInput("  ")).toBeNull();
    expect(webhookMaxPendingRunsInput("1")).toBe(1);
    expect(webhookMaxPendingRunsInput(" 12 ")).toBe(12);
    expect(webhookMaxPendingRunsInput("50")).toBe(50);
  });
  it("refuses anything the server would reject", () => {
    for (const text of ["0", "51", "2.5", "-3", "ten", "1e2"]) expect(webhookMaxPendingRunsInput(text)).toBeUndefined();
  });
});
