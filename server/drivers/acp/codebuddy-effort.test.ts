import { describe, expect, it } from "vitest";
import { splitCodeBuddyEffort, CODEBUDDY_EFFORTS } from "./codebuddy.ts";

describe("CodeBuddy reasoning effort", () => {
  it("reads an explicit variant as the effort and leaves the model alone", () => {
    expect(splitCodeBuddyEffort("grok-4.7", "high")).toEqual({ model: "grok-4.7", effort: "high" });
  });

  it.each(CODEBUDDY_EFFORTS.map((entry) => entry.id))("splits a -%s slug, as Cursor names its own variants", (level) => {
    const result = splitCodeBuddyEffort(`grok-4.7-${level}`, undefined);
    expect(result).toEqual({ model: "grok-4.7", effort: level });
  });

  it("keeps the CLI default when no effort was chosen", () => {
    expect(splitCodeBuddyEffort("grok-4.7", undefined)).toEqual({ model: "grok-4.7", effort: undefined });
    expect(splitCodeBuddyEffort(undefined, undefined)).toEqual({ model: undefined, effort: undefined });
  });

  it("does not mistake a hyphenated model id for an effort", () => {
    expect(splitCodeBuddyEffort("deepseek-v4.1-flash", undefined)).toEqual({ model: "deepseek-v4.1-flash", effort: undefined });
    expect(splitCodeBuddyEffort("fast-model", undefined)).toEqual({ model: "fast-model", effort: undefined });
    expect(splitCodeBuddyEffort("deepseek-v4.1-flash-sg", undefined)).toEqual({ model: "deepseek-v4.1-flash-sg", effort: undefined });
  });

  it("normalises the level's case, since argv is compared against the CLI's own lowercase names", () => {
    expect(splitCodeBuddyEffort("grok-4.7-MAX", undefined)).toEqual({ model: "grok-4.7", effort: "max" });
  });
});
