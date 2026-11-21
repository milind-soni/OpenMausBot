import { describe, expect, it } from "vitest";

import { planRoomDrop, roomDropPlace, stepRoom } from "./sidebar-room-drop";

const rooms = ["a", "b", "c", "d"];

describe("room drops", () => {
  it("lands in the upper or lower half of the row under the pointer", () => {
    expect(roomDropPlace(4, 40)).toBe("before");
    expect(roomDropPlace(20, 40)).toBe("after");
    expect(roomDropPlace(4, 0)).toBe("before");
  });

  it("moves a room before or after another in the same list", () => {
    expect(planRoomDrop(rooms, "d", "a", "before")).toEqual(["d", "a", "b", "c"]);
    expect(planRoomDrop(rooms, "a", "c", "after")).toEqual(["b", "c", "a", "d"]);
    expect(planRoomDrop(rooms, "a", "d", "after")).toEqual(["b", "c", "d", "a"]);
  });

  it("does nothing for a drop that changes nothing or leaves the list", () => {
    expect(planRoomDrop(rooms, "a", "a", "before")).toBeNull();
    expect(planRoomDrop(rooms, "a", "b", "before")).toBeNull();
    expect(planRoomDrop(rooms, "b", "a", "after")).toBeNull();
    expect(planRoomDrop(rooms, "x", "a", "before")).toBeNull();
    expect(planRoomDrop(rooms, "a", "x", "before")).toBeNull();
  });

  it("steps a room one place up or down, stopping at either end", () => {
    expect(stepRoom(rooms, "b", -1)).toEqual(["b", "a", "c", "d"]);
    expect(stepRoom(rooms, "b", 1)).toEqual(["a", "c", "b", "d"]);
    expect(stepRoom(rooms, "a", -1)).toBeNull();
    expect(stepRoom(rooms, "d", 1)).toBeNull();
    expect(stepRoom(rooms, "x", 1)).toBeNull();
  });
});
