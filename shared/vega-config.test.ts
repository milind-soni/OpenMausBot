import { describe, expect, it } from "vitest";

import { VEGA_CATEGORY_RANGE, VEGA_FONT, vegaConfig, vegaSurface } from "./vega-config.ts";

/** WCAG relative luminance and contrast ratio, as scripts/check-skin-contrast.mjs computes them. */
function luminance(hex: string): number {
  const channel = (i: number): number => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}
const contrast = (a: string, b: string): number => {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
};

describe("vegaConfig", () => {
  it("has ten categorical colours that read on a dark and a light ground (≥ 3:1)", () => {
    expect(VEGA_CATEGORY_RANGE).toHaveLength(10);
    expect(new Set(VEGA_CATEGORY_RANGE).size).toBe(10);
    for (const colour of VEGA_CATEGORY_RANGE) {
      expect(contrast(colour, "#111111"), `${colour} on dark`).toBeGreaterThanOrEqual(3);
      expect(contrast(colour, "#ffffff"), `${colour} on light`).toBeGreaterThanOrEqual(3);
    }
  });

  it("is transparent, set in the app's font, and the same palette on both themes", () => {
    for (const theme of ["light", "dark"] as const) {
      const config = vegaConfig(theme);
      expect(config.background).toBe("transparent");
      expect(config.font).toBe(VEGA_FONT);
      expect(VEGA_FONT).toContain("Inter");
      expect((config.range as { category: string[] }).category).toEqual([...VEGA_CATEGORY_RANGE]);
      expect((config.axis as { gridWidth: number }).gridWidth).toBe(1);
    }
  });

  it("inks text for its theme and the text clears AA on the surface", () => {
    const dark = vegaConfig("dark");
    const light = vegaConfig("light");
    expect((dark.title as { color: string }).color).toBe("#fcfcfc");
    expect((light.title as { color: string }).color).toBe("#1a1a18");
    for (const theme of ["light", "dark"] as const) {
      const axis = vegaConfig(theme).axis as { labelColor: string };
      expect(contrast(axis.labelColor, vegaSurface(theme))).toBeGreaterThanOrEqual(4.5);
    }
  });
});
