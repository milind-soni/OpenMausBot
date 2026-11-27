import { describe, expect, it } from "vitest";

import { rankByName } from "./palette-rank";

const names = (items: Array<{ name: string }>) => items.map((i) => i.name);

describe("rankByName", () => {
  it("puts prefix matches above substring matches", () => {
    const items = [{ name: "Big Momo" }, { name: "Momo" }, { name: "Lemon Momo" }];
    expect(names(rankByName(items, "mo"))).toEqual(["Momo", "Big Momo", "Lemon Momo"]);
  });

  it("matches case-insensitively on both sides", () => {
    const items = [{ name: "MOSS" }, { name: "quiet moss" }];
    expect(names(rankByName(items, "Moss"))).toEqual(["MOSS", "quiet moss"]);
  });

  it("keeps input order within a tier", () => {
    const items = [{ name: "Miso One" }, { name: "Miso Two" }, { name: "A Miso" }, { name: "B Miso" }];
    expect(names(rankByName(items, "miso"))).toEqual(["Miso One", "Miso Two", "A Miso", "B Miso"]);
  });

  it("filters out non-matches", () => {
    const items = [{ name: "Momo" }, { name: "Moss" }];
    expect(rankByName(items, "zebra")).toEqual([]);
    expect(names(rankByName(items, "oss"))).toEqual(["Moss"]);
  });

  it("returns everything in input order for an empty or whitespace query", () => {
    const items = [{ name: "Momo" }, { name: "Moss" }];
    expect(names(rankByName(items, ""))).toEqual(["Momo", "Moss"]);
    expect(names(rankByName(items, "   "))).toEqual(["Momo", "Moss"]);
  });
});
