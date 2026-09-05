import { describe, expect, it } from "vitest";

import { MAX_ZOOM, MIN_ZOOM, clampScale, panBy, zoomAt } from "./spaces-view";

const view = (scale = 1, x = 0, y = 0) => ({ scale, x, y });

describe("panBy", () => {
  it("moves the canvas opposite the scroll, so content follows the fingers", () => {
    // scrolling right (positive deltaX) should reveal content to the right,
    // which means the stage slides left
    expect(panBy(view(1, 100, 50), 30, 10)).toEqual({ scale: 1, x: 70, y: 40 });
  });

  it("pans in both axes at once — this is a canvas, not a filmstrip", () => {
    const moved = panBy(view(1, 0, 0), -25, -40);
    expect(moved.x).toBe(25);
    expect(moved.y).toBe(40);
  });

  it("leaves the zoom level alone", () => {
    expect(panBy(view(0.4, 0, 0), 10, 10).scale).toBe(0.4);
  });
});

describe("zoomAt", () => {
  it("keeps the point under the cursor pinned while zooming in", () => {
    const before = view(1, 0, 0);
    const cursor = { x: 400, y: 300 };
    // the stage point currently under the cursor
    const stagePoint = { x: (cursor.x - before.x) / before.scale, y: (cursor.y - before.y) / before.scale };
    const after = zoomAt(before, cursor, 1.25);
    expect(after.scale).toBeCloseTo(1.25);
    expect(after.scale * stagePoint.x + after.x).toBeCloseTo(cursor.x);
    expect(after.scale * stagePoint.y + after.y).toBeCloseTo(cursor.y);
  });

  it("keeps it pinned while zooming out too", () => {
    const before = view(1.2, -300, -120);
    const cursor = { x: 700, y: 500 };
    const stagePoint = { x: (cursor.x - before.x) / before.scale, y: (cursor.y - before.y) / before.scale };
    const after = zoomAt(before, cursor, 0.6);
    expect(after.scale * stagePoint.x + after.x).toBeCloseTo(cursor.x);
    expect(after.scale * stagePoint.y + after.y).toBeCloseTo(cursor.y);
  });

  it("does not zoom past the readable floor or the useful ceiling", () => {
    expect(zoomAt(view(MIN_ZOOM), { x: 0, y: 0 }, 0.1).scale).toBe(MIN_ZOOM);
    expect(zoomAt(view(MAX_ZOOM), { x: 0, y: 0 }, 10).scale).toBe(MAX_ZOOM);
  });

  it("still pins the cursor when the zoom is clamped", () => {
    const before = view(MIN_ZOOM * 1.05, 40, 40);
    const cursor = { x: 200, y: 200 };
    const after = zoomAt(before, cursor, 0.1);
    const stagePoint = { x: (cursor.x - before.x) / before.scale, y: (cursor.y - before.y) / before.scale };
    expect(after.scale).toBe(MIN_ZOOM);
    expect(after.scale * stagePoint.x + after.x).toBeCloseTo(cursor.x);
  });

  it("is a no-op at a factor of one", () => {
    expect(zoomAt(view(0.5, 10, 20), { x: 100, y: 100 }, 1)).toEqual(view(0.5, 10, 20));
  });
});

describe("clampScale", () => {
  it("holds the scale inside the usable range", () => {
    expect(clampScale(0.0001)).toBe(MIN_ZOOM);
    expect(clampScale(99)).toBe(MAX_ZOOM);
    expect(clampScale(0.7)).toBe(0.7);
  });
});
