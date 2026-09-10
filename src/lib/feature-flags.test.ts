import { describe, expect, it } from "vitest";

import { builtInBrowserEnabled, showToolCallsEnabled, skillAuthoringEnabled } from "./feature-flags";

describe("experimental feature flags", () => {
  it("keeps skill authoring on by default, before and after the config arrives", () => {
    expect(skillAuthoringEnabled(null)).toBe(true);
    expect(skillAuthoringEnabled({})).toBe(true);
    expect(skillAuthoringEnabled({ features: {} })).toBe(true);
    expect(skillAuthoringEnabled({ features: { skillAuthoring: true } })).toBe(true);
  });

  it("switches skill authoring off only on an explicit opt-out", () => {
    expect(skillAuthoringEnabled({ features: { skillAuthoring: false } })).toBe(false);
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
