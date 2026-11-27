import { describe, expect, it } from "vitest";

import { applyFit, boundsOf, fitTransform, flatten } from "./geometry.ts";

const FACE_BOX = 228.541;

/** A 100x100 box at the origin, as four degenerate cubics. */
const BOX =
  "M0 0 C33.33 0 66.67 0 100 0 C100 33.33 100 66.67 100 100 " +
  "C66.67 100 33.33 100 0 100 C0 66.67 0 33.33 0 0 Z";

describe("flatten", () => {
  it("walks a closed path into one polyline", () => {
    const polylines = flatten(BOX);
    expect(polylines).toHaveLength(1);
    expect(polylines[0].length).toBeGreaterThan(4);
  });

  it("keeps every sampled point on the box it came from", () => {
    for (const [x, y] of flatten(BOX)[0]) {
      const onEdge =
        Math.abs(x) < 0.01 || Math.abs(x - 100) < 0.01 ||
        Math.abs(y) < 0.01 || Math.abs(y - 100) < 0.01;
      expect(onEdge, `(${x}, ${y}) left the box`).toBe(true);
    }
  });
});

describe("boundsOf", () => {
  it("measures the drawn extent", () => {
    expect(boundsOf(flatten(BOX))).toEqual({
      minX: expect.closeTo(0, 2),
      minY: expect.closeTo(0, 2),
      maxX: expect.closeTo(100, 2),
      maxY: expect.closeTo(100, 2),
    });
  });
});

describe("fitTransform", () => {
  it("scales a square to fill the face box", () => {
    const fit = fitTransform({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
    expect(fit.scale).toBeCloseTo(FACE_BOX / 100, 5);
  });

  it("centres the narrow axis of a tall shape", () => {
    const fit = fitTransform({ minX: 0, minY: 0, maxX: 50, maxY: 100 });
    expect(fit.scale).toBeCloseTo(FACE_BOX / 100, 5);
    // 50 wide at that scale leaves half the box spare, split evenly.
    expect(fit.tx).toBeCloseTo(FACE_BOX / 4, 3);
    expect(fit.ty).toBeCloseTo(0, 3);
  });

  it("emits the transform in the format the renderer already parses", () => {
    const fit = fitTransform({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
    expect(fit.transform).toMatch(/^translate\(-?[\d.]+ -?[\d.]+\) scale\([\d.]+\)$/);
  });
});

describe("applyFit", () => {
  it("lands the shape inside the face box", () => {
    const fit = fitTransform({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
    const bounds = boundsOf(applyFit(flatten(BOX), fit));
    expect(bounds.minX).toBeGreaterThanOrEqual(-0.01);
    expect(bounds.minY).toBeGreaterThanOrEqual(-0.01);
    expect(bounds.maxX).toBeLessThanOrEqual(FACE_BOX + 0.01);
    expect(bounds.maxY).toBeLessThanOrEqual(FACE_BOX + 0.01);
  });
});
