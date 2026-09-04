import { describe, expect, it } from "vitest";

import { OWNED_RUNTIME_DISCLOSURE, authLabel, contextLabel } from "./context-label";

describe("contextLabel", () => {
  it("names each ownership mode in words a person can read", () => {
    expect(contextLabel("vendor-session")).toBe("Vendor session");
    expect(contextLabel("omb-replay")).toBe("OpenMaus replay");
    expect(contextLabel("omb-loop")).toBe("OpenMaus managed");
  });

  it("says nothing for an engine that has not declared one", () => {
    expect(contextLabel(undefined)).toBeUndefined();
  });
});

describe("authLabel", () => {
  it("labels a metered or custom engine as key-based and provider-billed", () => {
    expect(authLabel({ access: "custom", snapshot: { state: "available", billing: "metered" } })).toBe("API key · billed by the provider");
    expect(authLabel({ access: "custom", snapshot: { state: "unavailable" } })).toBe("API key · billed by the provider");
  });

  it("labels a subscription engine as a sign-in", () => {
    expect(authLabel({ access: "subscription", snapshot: { state: "available", billing: "subscription" } })).toBe("Subscription sign-in");
  });

  it("keeps ownership and billing as separate questions", () => {
    expect(contextLabel("omb-loop")).not.toMatch(/subscription|claude|codex/i);
    expect(authLabel({ access: "custom", snapshot: { state: "available", billing: "metered" } })).not.toMatch(/subscription/i);
  });
});

describe("OWNED_RUNTIME_DISCLOSURE", () => {
  it("states the two things a user must know before enabling it", () => {
    expect(OWNED_RUNTIME_DISCLOSURE).toMatch(/does not use a Claude or Codex login/);
    expect(OWNED_RUNTIME_DISCLOSURE).toMatch(/billed by that provider/);
  });
});
