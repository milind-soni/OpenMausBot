import { describe, expect, it } from "vitest";

import { webhookActivationDefaults } from "../components/WebhooksPanel";

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
