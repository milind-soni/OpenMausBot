import { describe, expect, it } from "vitest";

import { builtInBrowserEnabled, showToolCallsEnabled, skillRecorderEnabled } from "./feature-flags";

describe("experimental feature flags", () => {
  it("keeps Teach a skill hidden by default", () => {
    expect(skillRecorderEnabled(null)).toBe(false);
    expect(skillRecorderEnabled({})).toBe(false);
    expect(skillRecorderEnabled({ features: { skillRecorder: false } })).toBe(false);
  });

  it("shows Teach a skill only after explicit opt-in", () => {
    expect(skillRecorderEnabled({ features: { skillRecorder: true } })).toBe(true);
  });

  it("keeps the experimental browser off until explicitly enabled", () => {
    expect(builtInBrowserEnabled(null)).toBe(false);
    expect(builtInBrowserEnabled({})).toBe(false);
    expect(builtInBrowserEnabled({ features: { browser: false } })).toBe(false);
    expect(builtInBrowserEnabled({ features: { browser: true } })).toBe(true);
  });

  it("hides tool-call chips by default", () => {
    expect(showToolCallsEnabled(null)).toBe(false);
    expect(showToolCallsEnabled({})).toBe(false);
    expect(showToolCallsEnabled({ features: { showToolCalls: false } })).toBe(false);
  });

  it("shows tool-call chips only after explicit opt-in", () => {
    expect(showToolCallsEnabled({ features: { showToolCalls: true } })).toBe(true);
  });
});
