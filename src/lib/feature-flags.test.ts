import { describe, expect, it } from "vitest";

import { skillRecorderEnabled } from "./feature-flags";

describe("experimental feature flags", () => {
  it("keeps Teach a skill hidden by default", () => {
    expect(skillRecorderEnabled(null)).toBe(false);
    expect(skillRecorderEnabled({})).toBe(false);
    expect(skillRecorderEnabled({ features: { skillRecorder: false } })).toBe(false);
  });

  it("shows Teach a skill only after explicit opt-in", () => {
    expect(skillRecorderEnabled({ features: { skillRecorder: true } })).toBe(true);
  });
});
