import { describe, expect, it } from "vitest";

import { maskFromPolylines } from "./raster.ts";

const FACE_BOX = 228.541;
const SIZE = 256;

/** A circle of radius r centred in the face box, as a dense polygon. */
const circle = (r, steps = 512) => {
  const c = FACE_BOX / 2;
  const points = [];
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    points.push([c + Math.cos(a) * r, c + Math.sin(a) * r]);
  }
  return [points];
};

const at = (mask, x, y) => {
  const px = Math.floor((x / FACE_BOX) * SIZE);
  const py = Math.floor((y / FACE_BOX) * SIZE);
  return mask[py * SIZE + px];
};

describe("maskFromPolylines", () => {
  it("fills the inside and leaves the outside clear", () => {
    const mask = maskFromPolylines(circle(80));
    expect(at(mask, FACE_BOX / 2, FACE_BOX / 2)).toBe(1);
    expect(at(mask, 4, 4)).toBe(0);
  });

  it("covers the area the circle actually has", () => {
    const r = 80;
    const mask = maskFromPolylines(circle(r));
    let filled = 0;
    for (const value of mask) filled += value;

    const perPixel = (FACE_BOX / SIZE) ** 2;
    expect(filled * perPixel).toBeCloseTo(Math.PI * r * r, -2);
  });

  it("puts the edge where the radius says it is", () => {
    const mask = maskFromPolylines(circle(60));
    const c = FACE_BOX / 2;
    expect(at(mask, c + 55, c)).toBe(1);
    expect(at(mask, c + 65, c)).toBe(0);
  });

  it("clips shapes that run past the face box instead of wrapping them", () => {
    const mask = maskFromPolylines([[[-50, -50], [50, -50], [50, 50], [-50, 50]]]);
    expect(at(mask, 4, 4)).toBe(1);
    expect(at(mask, FACE_BOX - 4, FACE_BOX - 4)).toBe(0);
  });
});
