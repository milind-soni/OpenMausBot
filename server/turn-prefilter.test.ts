import { describe, expect, it } from "vitest";
import { isDeterministicNoChange, normalizeTurnText } from "./turn-prefilter.ts";

describe("turn prefilter", () => {
  it("folds Unicode normalization and whitespace deterministically", () => {
    expect(normalizeTurnText("  Café\n\t  plan  ")).toBe("Café plan");
    expect(isDeterministicNoChange("Café plan", " Café  plan ")).toBe(true);
  });

  it("does not suppress meaningful changes or a missing previous value", () => {
    expect(isDeterministicNoChange(undefined, "same")).toBe(false);
    expect(isDeterministicNoChange("Deploy now", "deploy now")).toBe(false);
    expect(isDeterministicNoChange("Deploy now", "Deploy now, please")).toBe(false);
  });
});
