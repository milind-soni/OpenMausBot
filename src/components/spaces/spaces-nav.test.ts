import { describe, expect, it } from "vitest";

import { clampIndex, navigate } from "./spaces-nav";

const row = (index: number) => ({ index, count: 9, columns: 3 });

describe("navigate", () => {
  it("steps forward and back in reading order", () => {
    expect(navigate(row(0), "next")).toBe(1);
    expect(navigate(row(4), "prev")).toBe(3);
  });

  it("wraps past the end of a row into the next one", () => {
    // index 2 is the last column of row 0; next is the first column of row 1
    expect(navigate(row(2), "next")).toBe(3);
  });

  it("clamps at both ends rather than cycling", () => {
    expect(navigate(row(8), "next")).toBe(8);
    expect(navigate(row(0), "prev")).toBe(0);
  });

  it("moves a whole row at a time vertically", () => {
    expect(navigate(row(1), "down")).toBe(4);
    expect(navigate(row(7), "up")).toBe(4);
  });

  it("stays put when there is no row above or below", () => {
    expect(navigate(row(1), "up")).toBe(1);
    expect(navigate(row(7), "down")).toBe(7);
  });

  it("does not fall into the gap of a partly filled last row", () => {
    // 7 cards over 3 columns: row 2 holds only index 6
    const short = { index: 5, count: 7, columns: 3 };
    expect(navigate(short, "down")).toBe(5);
    expect(navigate({ ...short, index: 3 }, "down")).toBe(6);
  });

  it("jumps to the first and last card", () => {
    expect(navigate(row(4), "first")).toBe(0);
    expect(navigate(row(4), "last")).toBe(8);
  });

  it("has nowhere to go on an empty canvas", () => {
    const empty = { index: 0, count: 0, columns: 0 };
    for (const intent of ["next", "prev", "up", "down", "first", "last"] as const) {
      expect(navigate(empty, intent)).toBe(-1);
    }
  });

  it("keeps a single card focused whatever you press", () => {
    const only = { index: 0, count: 1, columns: 1 };
    expect(navigate(only, "next")).toBe(0);
    expect(navigate(only, "down")).toBe(0);
  });
});

describe("clampIndex", () => {
  it("holds a valid index still", () => {
    expect(clampIndex(3, 9)).toBe(3);
  });

  it("falls back to the last card when the focused one is deleted", () => {
    expect(clampIndex(9, 9)).toBe(8);
    expect(clampIndex(40, 9)).toBe(8);
  });

  it("reports no focus once the last card is gone", () => {
    expect(clampIndex(0, 0)).toBe(-1);
  });

  it("never returns a negative index while cards remain", () => {
    expect(clampIndex(-3, 9)).toBe(0);
  });
});
