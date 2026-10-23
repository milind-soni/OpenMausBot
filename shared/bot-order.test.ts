import { describe, expect, it } from "vitest";

import { reorderStable } from "./bot-order.ts";

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
