import { describe, expect, it } from "vitest";

import {
  MIN_GRID_SCALE,
  TILE_COUNTS,
  gridColumns,
  layoutFor,
  transformForLayout,
} from "./spaces-layout";

const wide = { width: 1600, height: 1000 };
const narrow = { width: 900, height: 700 };
const tile = (per: 1 | 2 | 3) => ({ kind: "tile" as const, per });
const grid = { kind: "grid" as const };

describe("tiled layouts", () => {
  it("gives one bot the whole width", () => {
    const { cells } = layoutFor(6, wide, tile(1));
    expect(cells[0].width).toBeGreaterThan(wide.width * 0.9);
  });

  it("splits the width between two bots, and three", () => {
    const two = layoutFor(6, wide, tile(2)).cells[0].width;
    const three = layoutFor(6, wide, tile(3)).cells[0].width;
    const one = layoutFor(6, wide, tile(1)).cells[0].width;
    expect(two).toBeGreaterThan(one / 2 - 40);
    expect(two).toBeLessThan(one / 2 + 40);
    expect(three).toBeLessThan(two);
    expect(three).toBeGreaterThan(one / 3 - 40);
  });

  it("makes cards genuinely narrower rather than shrinking them — the point of split screen", () => {
    // at scale 1 the content is full size in every tiled mode
    for (const per of TILE_COUNTS) {
      const layout = layoutFor(6, wide, tile(per));
      expect(transformForLayout(layout, 0, wide).scale).toBe(1);
    }
  });

  it("lays every card out in one row, left to right", () => {
    const { cells } = layoutFor(5, wide, tile(2));
    expect(cells.every((c) => c.y === cells[0].y)).toBe(true);
    for (let i = 1; i < cells.length; i += 1) expect(cells[i].x).toBeGreaterThan(cells[i - 1].x);
  });

  it("gives every card the same box in a given mode", () => {
    const { cells } = layoutFor(7, wide, tile(3));
    expect(new Set(cells.map((c) => c.width)).size).toBe(1);
    expect(new Set(cells.map((c) => c.height)).size).toBe(1);
  });

  it("leaves room at the bottom for the floating composer", () => {
    const { cells } = layoutFor(4, wide, tile(1));
    expect(cells[0].height).toBeLessThan(wide.height - 80);
  });

  it("puts the focused card at the left edge of the visible run", () => {
    const layout = layoutFor(8, wide, tile(2));
    const t0 = transformForLayout(layout, 0, wide);
    const t1 = transformForLayout(layout, 1, wide);
    // card 1 lands exactly where card 0 was
    expect(layout.cells[1].x + t1.x).toBeCloseTo(layout.cells[0].x + t0.x);
  });

  it("shows the n-th card alongside its neighbours, all on screen", () => {
    const layout = layoutFor(8, wide, tile(3));
    const t = transformForLayout(layout, 2, wide);
    for (const i of [2, 3, 4]) {
      const left = layout.cells[i].x + t.x;
      expect(left).toBeGreaterThanOrEqual(-1);
      expect(left + layout.cells[i].width).toBeLessThanOrEqual(wide.width + 1);
    }
  });
});

describe("grid layout", () => {
  it("wraps the same full-size cards into rows", () => {
    const { cells } = layoutFor(9, wide, grid);
    const columns = gridColumns(9, wide);
    expect(new Set(cells.map((c) => c.y)).size).toBe(Math.ceil(9 / columns));
    expect(cells[0].width).toBeCloseTo(layoutFor(9, wide, tile(1)).cells[0].width);
  });

  it("shrinks the whole thing to fit, and ignores which card is focused", () => {
    const layout = layoutFor(6, wide, grid);
    const t = transformForLayout(layout, 0, wide);
    expect(t.scale).toBeLessThan(1);
    expect(layout.stage.width * t.scale).toBeLessThanOrEqual(wide.width);
    expect(transformForLayout(layout, 4, wide)).toEqual(t);
  });

  it("stops at the legibility floor and scrolls instead", () => {
    const layout = layoutFor(60, wide, grid);
    const t = transformForLayout(layout, 0, wide);
    expect(t.scale).toBe(MIN_GRID_SCALE);
    expect(t.scrollable).toBe(true);
  });

  it("tiles fewer columns in a narrow window", () => {
    expect(gridColumns(9, narrow)).toBeLessThan(gridColumns(9, wide));
  });

  it("never uses more columns than there are cards", () => {
    expect(gridColumns(1, wide)).toBe(1);
    expect(gridColumns(2, wide)).toBe(2);
  });
});

describe("edge cases", () => {
  it("has no cells and no stage for an empty canvas", () => {
    for (const view of [tile(1), tile(3), grid]) {
      const layout = layoutFor(0, wide, view);
      expect(layout.cells).toEqual([]);
      expect(layout.stage).toEqual({ width: 0, height: 0 });
    }
  });

  it("handles a single bot in every mode without dividing by zero", () => {
    for (const view of [tile(1), tile(2), tile(3), grid]) {
      const layout = layoutFor(1, wide, view);
      expect(layout.cells).toHaveLength(1);
      expect(Number.isFinite(transformForLayout(layout, 0, wide).x)).toBe(true);
    }
  });

  it("does not scroll a tiled row past its last card", () => {
    const layout = layoutFor(4, wide, tile(3));
    const last = transformForLayout(layout, 3, wide);
    const first = transformForLayout(layout, 0, wide);
    // only one card's worth of run remains, so it clamps rather than leaving a void
    expect(last.x).toBeLessThanOrEqual(first.x);
    const rightmost = layout.cells[3].x + layout.cells[3].width + last.x;
    expect(rightmost).toBeLessThanOrEqual(wide.width + 1);
  });
});
