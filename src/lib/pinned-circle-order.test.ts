import { describe, expect, it } from "vitest";
import {
  PINNED_CIRCLE_DRAG_THRESHOLD_PX,
  PINNED_CIRCLE_DRAG_TYPE,
  draggedPinnedCircle,
  movePinnedCircle,
  orderedPinnedCircles,
  pinnedCircleDragBlocked,
  pinnedCircleDragPastThreshold,
  pinnedCircleDropPlace,
  placePinnedCircle,
  rankPinnedCircles,
} from "./pinned-circle-order";

describe("pinned circle order", () => {
  const ids = ["a", "b", "c"];

  it("moves an id before another and leaves unknown ids unchanged", () => {
    expect(placePinnedCircle(ids, "c", "a", "before")).toEqual(["c", "a", "b"]);
    expect(placePinnedCircle(ids, "a", "c", "after")).toEqual(["b", "c", "a"]);
    expect(placePinnedCircle(ids, "missing", "a", "before")).toEqual(ids);
    expect(placePinnedCircle(ids, "a", "missing", "after")).toEqual(ids);
    expect(placePinnedCircle(ids, "a", "a", "before")).toEqual(ids);
    expect(movePinnedCircle(ids, "missing", -1)).toEqual(ids);
    expect(movePinnedCircle(ids, "b", -1)).toEqual(["b", "a", "c"]);
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("omits unpinned ids and appends new pins", () => {
    expect(orderedPinnedCircles(["a", "c"], ["a", "b", "c"])).toEqual(["a", "c"]);
    expect(orderedPinnedCircles(["a", "b", "c"], ["b", "a"])).toEqual(["b", "a", "c"]);
    expect(orderedPinnedCircles(["a", "b", "c"], [])).toEqual(["a", "b", "c"]);
    expect(orderedPinnedCircles(["a", "b"], ["gone"])).toEqual(["a", "b"]);
  });

  it("keeps saved array order when the grid reflows", () => {
    const pinned = ["a", "b", "c", "d", "e", "f"];
    const saved = ["d", "a", "e", "b", "f", "c"];
    // Three columns paint d a e / b f c. Two columns paint d a / e b / f c.
    // Both readings are the saved array, not a geometry sort.
    expect([saved.slice(0, 3), saved.slice(3)]).toEqual([["d", "a", "e"], ["b", "f", "c"]]);
    expect([saved.slice(0, 2), saved.slice(2, 4), saved.slice(4)]).toEqual([["d", "a"], ["e", "b"], ["f", "c"]]);
    expect(orderedPinnedCircles(pinned, saved)).toEqual(saved);
    expect(orderedPinnedCircles([...pinned].reverse(), saved)).toEqual(saved);
    expect(rankPinnedCircles(pinned.map((id) => ({ id })), saved).map((bot) => bot.id)).toEqual(saved);
  });

  it("accepts only a circle payload for an id that is still in the grid", () => {
    expect(draggedPinnedCircle(JSON.stringify({ botId: "b" }), ids)).toBe("b");
    expect(draggedPinnedCircle(JSON.stringify({ botId: "gone" }), ids)).toBeNull();
    for (const raw of ["b", "bots", "{}", "null", "[]", "true"]) expect(draggedPinnedCircle(raw, ids)).toBeNull();
    expect(PINNED_CIRCLE_DRAG_TYPE).not.toBe("application/x-openmausbot-folder");
    expect(PINNED_CIRCLE_DRAG_TYPE).not.toBe("application/x-openmausbot-sidebar-section");
  });

  it("treats a short move as a click and ignores rename fields and text selections", () => {
    expect(pinnedCircleDragPastThreshold(PINNED_CIRCLE_DRAG_THRESHOLD_PX - 1, 0)).toBe(false);
    expect(pinnedCircleDragPastThreshold(0, 0)).toBe(false);
    expect(pinnedCircleDragPastThreshold(PINNED_CIRCLE_DRAG_THRESHOLD_PX, 0)).toBe(true);
    expect(pinnedCircleDragBlocked(false, false)).toBe(false);
    expect(pinnedCircleDragBlocked(true, false)).toBe(true);
    expect(pinnedCircleDragBlocked(false, true)).toBe(true);
    const rect = { left: 0, top: 0, width: 80, height: 80 };
    expect(pinnedCircleDropPlace(10, 40, rect).place).toBe("before");
    expect(pinnedCircleDropPlace(70, 40, rect).place).toBe("after");
    expect(pinnedCircleDropPlace(70, 40, rect, true).place).toBe("before");
  });
});
