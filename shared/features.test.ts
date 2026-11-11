import { describe, expect, it } from "vitest";
import { FEATURE_DEFAULTS, featureConfigSchema } from "./features";
import { FEATURE_CATALOG } from "../src/lib/feature-catalog";

describe("workspace feature contract", () => {
  it("covers every editable field with defaults and discovery metadata", () => {
    const keys = Object.keys(featureConfigSchema.shape).sort();
    expect(Object.keys(FEATURE_DEFAULTS).sort()).toEqual(keys);
    expect(Object.keys(FEATURE_CATALOG).sort()).toEqual(keys);
    expect(featureConfigSchema.parse(FEATURE_DEFAULTS)).toEqual(FEATURE_DEFAULTS);
    for (const [key, entry] of Object.entries(FEATURE_CATALOG)) {
      expect(entry.anchor).toBe(`feature-${key}`);
      expect(entry.labelKey).toBe(`settings.features.${key}.label`);
      expect(entry.descriptionKey).toBe(`settings.features.${key}.description`);
      expect(entry.documentation).toContain("docs/feature-flags.md#");
    }
  });

  it("accepts partial updates and drops unknown capabilities without changing defaults", () => {
    expect(featureConfigSchema.parse({ skillsLibrary: true, savedStepsHere: true, unknown: true })).toEqual({ skillsLibrary: true });
    expect(featureConfigSchema.parse({})).toEqual({});
    expect(featureConfigSchema.safeParse({ skillReviewSteps: 2 }).success).toBe(false);
    expect(featureConfigSchema.safeParse({ skillReviewSteps: 101 }).success).toBe(false);
    expect(featureConfigSchema.safeParse({ skillReviewSteps: 3.5 }).success).toBe(false);
    expect(featureConfigSchema.safeParse({ shareLearnedSkills: "public" }).success).toBe(false);
    expect(featureConfigSchema.parse({ skillReviewSteps: 100, shareLearnedSkills: "auto" })).toEqual({ skillReviewSteps: 100, shareLearnedSkills: "auto" });
  });
});
