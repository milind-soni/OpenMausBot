import { describe, expect, it } from "vitest";

import { recentBotsFirst, reorderStable } from "./bot-order.ts";

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

describe("recentBotsFirst", () => {
  const order = (activity: Record<string, number>, placed: Record<string, number> = {}, list = ["a", "b", "c", "d"]) =>
    ids(recentBotsFirst(items(...list), (bot) => activity[bot.id] ?? 0, (bot) => placed[bot.id] ?? 0));

  it("leaves the order alone with no activity", () => {
    expect(order({})).toEqual(["a", "b", "c", "d"]);
  });

  it("puts bots active since they were placed first, newest first, and keeps the rest in order", () => {
    expect(order({ c: 5, d: 9 })).toEqual(["d", "c", "a", "b"]);
    expect(order({ c: 5, d: 5 })).toEqual(["c", "d", "a", "b"]);
  });

  it("keeps a bot where it was placed when its activity is older", () => {
    expect(order({ c: 5, d: 9 }, { c: 7 })).toEqual(["d", "a", "b", "c"]);
  });

  it("gives the same order when applied to its own output", () => {
    const once = order({ b: 3, d: 9 }, { a: 1 });
    expect(order({ b: 3, d: 9 }, { a: 1 }, once)).toEqual(once);
  });
});
