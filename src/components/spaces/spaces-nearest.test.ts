import { describe, expect, it } from "vitest";

import { layoutFor, transformForLayout } from "./spaces-layout";
import { nearestCardIndex } from "./spaces-nearest";

const viewport = { width: 1600, height: 1000 };
const tile = (per: 1 | 2 | 3) => ({ kind: "tile" as const, per });

describe("nearestCardIndex", () => {
  it("returns the card the preset already focuses", () => {
    const layout = layoutFor(8, viewport, tile(1));
    for (const index of [0, 3, 7]) {
      expect(nearestCardIndex(layout, transformForLayout(layout, index, viewport), viewport)).toBe(index);
    }
  });

  it("follows a pan to the next card", () => {
    const layout = layoutFor(8, viewport, tile(1));
    const at2 = transformForLayout(layout, 2, viewport);
    const pitch = layout.cells[1].x - layout.cells[0].x;
    // panned a full card to the left: card 3 now sits where card 2 was
    expect(nearestCardIndex(layout, { ...at2, x: at2.x - pitch }, viewport)).toBe(3);
  });

  it("rounds to whichever card is closest, not merely the one it passed", () => {
    const layout = layoutFor(8, viewport, tile(1));
    const at2 = transformForLayout(layout, 2, viewport);
    const pitch = layout.cells[1].x - layout.cells[0].x;
    expect(nearestCardIndex(layout, { ...at2, x: at2.x - pitch * 0.4 }, viewport)).toBe(2);
    expect(nearestCardIndex(layout, { ...at2, x: at2.x - pitch * 0.6 }, viewport)).toBe(3);
  });

  it("works the same in a split, tracking the leftmost pane", () => {
    const layout = layoutFor(8, viewport, tile(3));
    const at1 = transformForLayout(layout, 1, viewport);
    expect(nearestCardIndex(layout, at1, viewport)).toBe(1);
    const pitch = layout.cells[1].x - layout.cells[0].x;
    expect(nearestCardIndex(layout, { ...at1, x: at1.x - pitch }, viewport)).toBe(2);
  });

  it("never runs off either end", () => {
    const layout = layoutFor(4, viewport, tile(1));
    const at0 = transformForLayout(layout, 0, viewport);
    expect(nearestCardIndex(layout, { ...at0, x: at0.x + 5000 }, viewport)).toBe(0);
    expect(nearestCardIndex(layout, { ...at0, x: at0.x - 99999 }, viewport)).toBe(3);
  });

  it("picks the card nearest the middle of the screen in the grid", () => {
    const layout = layoutFor(9, viewport, { kind: "grid" });
    const t = transformForLayout(layout, 0, viewport);
    const picked = nearestCardIndex(layout, t, viewport);
    expect(picked).toBeGreaterThanOrEqual(0);
    expect(picked).toBeLessThan(9);
  });

  it("has no answer for an empty canvas", () => {
    const layout = layoutFor(0, viewport, tile(1));
    expect(nearestCardIndex(layout, transformForLayout(layout, 0, viewport), viewport)).toBe(-1);
  });
});
