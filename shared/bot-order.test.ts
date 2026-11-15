import { describe, expect, it } from "vitest";

import { reorderIfMoved, reorderInPlace, reorderStable } from "./bot-order.ts";

const items = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = (list: ReadonlyArray<{ id: string }>) => list.map((item) => item.id);

describe("reorderStable", () => {
  it("applies a full order", () => {
    expect(ids(reorderStable(items("a", "b", "c"), ["c", "a", "b"]))).toEqual(["c", "a", "b"]);
  });

  it("moves only the listed items, into the positions they already share, and leaves the rest where they are", () => {
    // a and c occupy positions 0 and 2: c takes 0, a takes 2; b and d never move.
    expect(ids(reorderStable(items("a", "b", "c", "d"), ["c", "a"]))).toEqual(["c", "b", "a", "d"]);
    // A one-step move inside a bucket: swapping d with its neighbour b leaves a and c alone.
    expect(ids(reorderStable(items("a", "b", "c", "d"), ["d", "b"]))).toEqual(["a", "d", "c", "b"]);
  });

  it("ignores ids it does not have and keeps the items themselves", () => {
    const list = items("a", "b", "c");
    const out = reorderStable(list, ["ghost", "b", "a"]);
    expect(ids(out)).toEqual(["b", "a", "c"]);
    expect(out[0]).toBe(list[1]);
    expect(out[2]).toBe(list[2]);
    expect(ids(list)).toEqual(["a", "b", "c"]);
  });

  it("returns the same order for an empty or unchanged list", () => {
    expect(ids(reorderStable(items("a", "b"), []))).toEqual(["a", "b"]);
    expect(ids(reorderStable(items("a", "b"), ["a", "b"]))).toEqual(["a", "b"]);
  });
});

describe("reorderInPlace", () => {
  it("reorders the same array, keeping its records", () => {
    const list = items("a", "b", "c");
    const [a, , c] = list;
    expect(reorderInPlace(list, ["c", "a"])).toBe(true);
    expect(ids(list)).toEqual(["c", "b", "a"]);
    expect(list[0]).toBe(c);
    expect(list[2]).toBe(a);
  });

  it("refuses an empty list, a repeated id or one it does not have, and leaves the array alone", () => {
    const list = items("a", "b");
    expect(reorderInPlace(list, [])).toBe(false);
    expect(reorderInPlace(list, ["b", "b"])).toBe(false);
    expect(reorderInPlace(list, ["b", "ghost"])).toBe(false);
    expect(ids(list)).toEqual(["a", "b"]);
  });
});

describe("reorderIfMoved", () => {
  it("gives the new order, or null when nothing moved", () => {
    const list = items("a", "b", "c");
    expect(ids(reorderIfMoved(list, ["c", "a"])!)).toEqual(["c", "b", "a"]);
    expect(reorderIfMoved(list, ["a", "c"])).toBeNull();
    expect(reorderIfMoved(list, ["ghost"])).toBeNull();
  });
});
