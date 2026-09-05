import { describe, expect, it } from "vitest";

import { builtInBrowserEnabled, showToolCallsEnabled, skillRecorderEnabled, spacesEnabled } from "./feature-flags";

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

describe("spacesEnabled", () => {
  it("keeps the Spaces canvas off until it is explicitly switched on", () => {
    expect(spacesEnabled(null)).toBe(false);
    expect(spacesEnabled(undefined)).toBe(false);
    expect(spacesEnabled({})).toBe(false);
    expect(spacesEnabled({ features: {} })).toBe(false);
    expect(spacesEnabled({ features: { spaces: false } })).toBe(false);
  });

  it("shows the Spaces canvas only after explicit opt-in", () => {
    expect(spacesEnabled({ features: { spaces: true } })).toBe(true);
  });

  it("does not let another experiment switch Spaces on", () => {
    expect(spacesEnabled({ features: { browser: true, skillRecorder: true } })).toBe(false);
  });
});
