import { describe, expect, it } from "vitest";
import { copyRoomPick, pointedResponders, roomPickBots, takeRoomPick, type RoomPick } from "./room-pointed.ts";

const pick = (blocks: Record<string, string>): RoomPick => ({ refs: [{ appId: "app-1", label: "Go" }], blocks });

describe("room picks", () => {
  it("gives each bot the records of its own pages once, and nothing to another member", () => {
    const holder = { pick: pick({ designer: "A", writer: "B" }) };
    expect(roomPickBots(holder.pick)).toEqual(["designer", "writer"]);
    expect(takeRoomPick(holder, "helper")).toBe("");
    expect(takeRoomPick(holder, "designer")).toBe("A");
    expect(takeRoomPick(holder, "designer")).toBe("");
    expect(takeRoomPick(holder, "writer")).toBe("B");
    expect(takeRoomPick(undefined, "designer")).toBe("");
    expect(takeRoomPick({}, "designer")).toBe("");
    expect(roomPickBots(undefined)).toEqual([]);
  });

  it("works on a copy, so taking a part leaves the queued line's pick whole", () => {
    const queued = pick({ designer: "A" });
    const run = { pick: copyRoomPick(queued) };
    expect(takeRoomPick(run, "designer")).toBe("A");
    expect(queued.blocks).toEqual({ designer: "A" });
  });

  it("sends the line to the page's bot first, then anyone named, and to no hidden member", () => {
    const designer = { id: "designer" }, helper = { id: "helper" }, writer = { id: "writer", hidden: true };
    const members = [helper, designer, writer];
    expect(pointedResponders(pick({ designer: "A" }), members, () => [helper, designer])).toEqual([designer, helper]);
    expect(pointedResponders(pick({ writer: "B" }), members, () => [helper])).toEqual([]);
    expect(pointedResponders(undefined, members, () => [helper])).toEqual([]);
  });
});
