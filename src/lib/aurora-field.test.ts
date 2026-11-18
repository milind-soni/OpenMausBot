import { describe, expect, it } from "vitest";
import { bandLight, paintAuroraField } from "./aurora-field";

const brightness = ([r, g, b]: readonly number[]) => r! + g! + b!;

function brightestRow(x: number, w: number, h: number): { y: number; light: number } {
  let best = { y: 0, light: 0 };
  for (let y = 0; y < h; y += 2) {
    const light = brightness(bandLight(x, y, w, h));
    if (light > best.light) best = { y, light };
  }
  return best;
}

describe("aurora field", () => {
  it("crosses the window as one bright band over a dark ground", () => {
    const band = brightestRow(900, 1874, 1162);
    expect(band.light).toBeGreaterThan(1.5);
    expect(brightness(bandLight(900, band.y + 400, 1874, 1162))).toBeLessThan(band.light / 4);
    expect(brightness(bandLight(200, 1120, 1874, 1162))).toBeLessThan(0.1);
  });

  it("falls from the top left to the lower right", () => {
    expect(brightestRow(1600, 1874, 1162).y).toBeGreaterThan(brightestRow(500, 1874, 1162).y);
  });

  it("keeps the band near the same place on a smaller screen", () => {
    const full = brightestRow(900, 1874, 1162);
    const half = brightestRow(450, 937, 581);
    expect(Math.abs(half.y / 581 - full.y / 1162)).toBeLessThan(0.05);
  });

  it("does nothing outside a page", () => {
    expect(() => paintAuroraField()).not.toThrow();
  });
});
