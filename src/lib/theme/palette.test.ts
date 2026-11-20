import { describe, expect, it } from "vitest";

import { accentPalette, canvasPalette, contrast, modeOf, parseHex } from "./palette";

describe("canvasPalette", () => {
  it.each([["#0b1020", "dark"], ["#1e1e2e", "dark"], ["#fdf6e3", "light"], ["#ffffff", "light"], ["#3a5f0b", "dark"]] as const)(
    "%s reads as %s and keeps its text readable", (canvas, mode) => {
      expect(modeOf(canvas)).toBe(mode);
      const palette = canvasPalette(canvas, mode);
      expect(palette.app).toBe(canvas);
      expect(contrast(parseHex(palette.ink!), parseHex(canvas))).toBeGreaterThanOrEqual(7);
      expect(contrast(parseHex(palette["ink-secondary"]!), parseHex(palette["raised-hover"]!))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(parseHex(palette["ink-tertiary"]!), parseHex(palette["raised-hover"]!))).toBeGreaterThanOrEqual(4.5);
    });
});

it("gives an accent a readable text tone and ink", () => {
  const palette = accentPalette("#ffd400", "light", "#ffffff");
  expect(contrast(parseHex(palette["accent-text"]!), parseHex("#ffffff"))).toBeGreaterThanOrEqual(4.5);
  expect(palette["accent-ink"]).toBe("#111111");
  expect(accentPalette("#5b21b6", "dark", "#0b1020")["accent-ink"]).toBe("#ffffff");
});
