import { describe, expect, it } from "vitest";
import {
  PINNED_CIRCLE_DRAG_TYPE,
  pinnedCircleDropPlace,
  placePinnedCircle,
  rankPinnedCircles,
  reorderPinnedCircles,
} from "./pinned-circle-order";

describe("pinned circle order", () => {
  const ids = ["a", "b", "c"];

  it("moves an id before another and leaves unknown ids unchanged", () => {
    expect(placePinnedCircle(ids, "c", "a", "before")).toEqual(["c", "a", "b"]);
    expect(placePinnedCircle(ids, "a", "c", "after")).toEqual(["b", "c", "a"]);
    expect(placePinnedCircle(ids, "missing", "a", "before")).toEqual(ids);
    expect(placePinnedCircle(ids, "a", "missing", "after")).toEqual(ids);
    expect(placePinnedCircle(ids, "a", "a", "before")).toEqual(ids);
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("reorders among the shown circles and keeps saved ids the grid does not show", () => {
    expect(reorderPinnedCircles([], ["a", "b", "c"], "c", "a", "before")).toEqual(["c", "a", "b"]);
    expect(reorderPinnedCircles(["chief", "b", "a"], ["b", "a", "new"], "new", "b", "before")).toEqual(["chief", "new", "b", "a"]);
    expect(reorderPinnedCircles(["a", "b"], ["a", "b"], "a", "b", "before")).toBeNull();
    expect(reorderPinnedCircles(["a", "b"], ["a", "b"], "a", "a", "after")).toBeNull();
    expect(reorderPinnedCircles(["a", "b", "gone"], ["a", "b"], "gone", "a", "before")).toBeNull();
    expect(reorderPinnedCircles(["a", "b"], ["a", "b"], "", "a", "before")).toBeNull();
  });

  it("ranks by the saved array, whatever rows the grid wraps into, and appends new pins in their own order", () => {
    const pinned = ["a", "b", "c", "d", "e", "f"].map((id) => ({ id }));
    const saved = ["d", "a", "e", "b", "f", "c"];
    expect(rankPinnedCircles(pinned, saved).map((bot) => bot.id)).toEqual(saved);
    expect(rankPinnedCircles([...pinned].reverse(), saved).map((bot) => bot.id)).toEqual(saved);
    expect(rankPinnedCircles(pinned, ["c", "gone"]).map((bot) => bot.id)).toEqual(["c", "a", "b", "d", "e", "f"]);
    expect(rankPinnedCircles(pinned, []).map((bot) => bot.id)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("uses its own drag type and picks the side of the circle in reading order", () => {
    expect(PINNED_CIRCLE_DRAG_TYPE).not.toBe("application/x-openmausbot-folder");
    expect(PINNED_CIRCLE_DRAG_TYPE).not.toBe("application/x-openmausbot-sidebar-section");
    const rect = { left: 0, top: 0, width: 80, height: 80 };
    expect(pinnedCircleDropPlace(10, 40, rect)).toEqual({ place: "before", axis: "x" });
    expect(pinnedCircleDropPlace(70, 40, rect)).toEqual({ place: "after", axis: "x" });
    expect(pinnedCircleDropPlace(70, 40, rect, true)).toEqual({ place: "before", axis: "x" });
    expect(pinnedCircleDropPlace(40, 5, rect)).toEqual({ place: "before", axis: "y" });
    expect(pinnedCircleDropPlace(40, 75, rect)).toEqual({ place: "after", axis: "y" });
  });
});
