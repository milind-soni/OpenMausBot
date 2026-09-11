import { describe, expect, it } from "vitest";

import {
  botDropPlace,
  botDropTarget,
  botFloatPosition,
  botLongPressShouldCancel,
} from "./sidebar-bot-drag";

describe("sidebar bot long-press drag", () => {
  it("cancels a pending lift after the finger moves, not for jitter", () => {
    expect(botLongPressShouldCancel(10, 10, 12, 11)).toBe(false);
    expect(botLongPressShouldCancel(10, 10, 10, 21)).toBe(true);
    expect(botLongPressShouldCancel(0, 0, 6, 6, 10)).toBe(false);
  });

  it("splits a row at its midline", () => {
    expect(botDropPlace(24, 20, 40)).toBe("before");
    expect(botDropPlace(41, 20, 40)).toBe("after");
  });

  it("keeps the floating row under the original grab point", () => {
    expect(botFloatPosition(100, 80, 12, 20)).toEqual({ left: 88, top: 60 });
  });

  it("targets the nearest other row and ignores the lifted one", () => {
    const rows = [
      { id: "waffle", top: 0, height: 40 },
      { id: "finch", top: 44, height: 40 },
      { id: "churro", top: 88, height: 40 },
    ];
    expect(botDropTarget(10, rows, "finch")).toEqual({ id: "waffle", place: "before" });
    expect(botDropTarget(30, rows, "finch")).toEqual({ id: "waffle", place: "after" });
    expect(botDropTarget(100, rows, "finch")).toEqual({ id: "churro", place: "before" });
    expect(botDropTarget(200, rows, "waffle")).toEqual({ id: "churro", place: "after" });
    expect(botDropTarget(70, rows, "waffle")).toEqual({ id: "finch", place: "after" });
    expect(botDropTarget(0, [{ id: "only", top: 0, height: 40 }], "only")).toBeNull();
  });
});
