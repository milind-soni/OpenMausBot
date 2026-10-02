import { describe, expect, it } from "vitest";
import { friendlyEffort, modelBlurb, simpleEffortLevels } from "./model-friendly";

describe("simple effort levels", () => {
  it("offers quick, balanced, deep and max when the engine has them", () => {
    expect(simpleEffortLevels(["none", "low", "medium", "high", "xhigh", "max"], undefined)).toEqual(["low", "medium", "high", "max"]);
    expect(["low", "medium", "high", "max"].map((level) => friendlyEffort(level as never))).toEqual(["Quick", "Balanced", "Deep", "Max"]);
  });

  it("uses X-High as the top step when there is no max", () => {
    expect(simpleEffortLevels(["low", "medium", "high", "xhigh"], undefined)).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("never hides the level a bot is already using", () => {
    expect(simpleEffortLevels(["none", "low", "medium", "high", "xhigh", "max"], "xhigh")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(simpleEffortLevels(["none", "low", "medium", "high"], "none")).toEqual(["none", "low", "medium", "high"]);
  });

  it("ignores a stale current level the engine no longer offers", () => {
    expect(simpleEffortLevels(["low", "high"], "max")).toEqual(["low", "high"]);
  });

  it("returns nothing for an engine without effort levels", () => {
    expect(simpleEffortLevels([], undefined)).toEqual([]);
  });
});

describe("model blurbs", () => {
  it("describes the well-known Claude families", () => {
    expect(modelBlurb({ id: "claude-opus-5-5", label: "Opus 5.5" })).toMatch(/Smartest/);
    expect(modelBlurb({ id: "claude-sonnet-5-5", label: "Sonnet 5.5" })).toMatch(/most work/);
    expect(modelBlurb({ id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" })).toMatch(/Quickest/);
  });

  it("calls small variants light without guessing at unknown models", () => {
    expect(modelBlurb({ id: "gpt-5-mini", label: "GPT-5 mini" })).toMatch(/light/);
    expect(modelBlurb({ id: "minimax-m2", label: "MiniMax M2" })).toBeUndefined();
    expect(modelBlurb({ id: "grok-4", label: "Grok 4" })).toBeUndefined();
  });
});
