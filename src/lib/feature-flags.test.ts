import { describe, expect, it } from "vitest";

import { builtInBrowserEnabled, showToolCallsEnabled, skillAuthoringEnabled } from "./feature-flags";

describe("experimental feature flags", () => {
  it("keeps skill authoring off by default", () => {
    expect(skillAuthoringEnabled(null)).toBe(false);
    expect(skillAuthoringEnabled({})).toBe(false);
    expect(skillAuthoringEnabled({ features: { skillAuthoring: false } })).toBe(false);
  });

  it("enables skill authoring only after explicit opt-in", () => {
    expect(skillAuthoringEnabled({ features: { skillAuthoring: true } })).toBe(true);
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
