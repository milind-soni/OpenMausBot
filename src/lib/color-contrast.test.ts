import { describe, expect, it } from "vitest";
import { fromOklch, parseHex, toOklch } from "./color-contrast";
import { MAUS_COLORS } from "./mascot";

describe("oklch", () => {
  it.each(Object.entries(MAUS_COLORS))("round-trips %s through OKLCH", (_name, hex) => {
    const back = parseHex(fromOklch(toOklch(hex)));
    const want = parseHex(hex);
    expect(Math.abs(back.r - want.r)).toBeLessThanOrEqual(1);
    expect(Math.abs(back.g - want.g)).toBeLessThanOrEqual(1);
    expect(Math.abs(back.b - want.b)).toBeLessThanOrEqual(1);
  });

  it("reads white and black at the ends of lightness with no chroma", () => {
    expect(toOklch("#ffffff").l).toBeCloseTo(1, 3);
    expect(toOklch("#000000").l).toBeCloseTo(0, 3);
    expect(toOklch("#808080").c).toBeLessThan(0.001);
  });

  it("gives up chroma, not lightness or hue, to stay inside sRGB", () => {
    const wanted = { l: 0.5, c: 0.4, h: 145 };
    const got = toOklch(fromOklch(wanted));
    expect(got.l).toBeCloseTo(wanted.l, 2);
    expect(Math.abs(got.h - wanted.h)).toBeLessThan(2);
    expect(got.c).toBeLessThan(wanted.c);
  });
});
