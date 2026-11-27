import { describe, expect, it } from "vitest";

import { roomQueuedReason, type RoomQueuedReasonDeps } from "./room-queued-reason.ts";

const ROOM_X = { id: "gx", name: "Room X", threadId: "x" };
const ROOM_Y = { id: "gy", name: "Room Y", threadId: "y" };
const rooms = new Map([[ROOM_X.id, ROOM_X], [ROOM_Y.id, ROOM_Y]]);
const threads = new Map([["x", ROOM_X], ["x1", ROOM_X], ["x2", ROOM_X], ["y", ROOM_Y], ["y1", ROOM_Y]]);
const speaker = (botId: string, name: string) => ({ botId, name });

function fixture(speakers: Record<string, { botId: string; name: string }>): RoomQueuedReasonDeps {
  const map = new Map(Object.entries(speakers));
  return { group: (id) => rooms.get(id), roomOfThread: (id) => threads.get(id), speaker: (id) => map.get(id), speakers: () => map };
}

const node = (over: Partial<{ groupId: string; botId: string; threadId: string }> = {}) =>
  ({ groupId: ROOM_X.id, botId: "bot-bob", threadId: "x2", ...over });

describe("a queued room hand-off's reason", () => {
  it("names the speaker in the hand-off's own thread", () => {
    expect(roomQueuedReason(node(), fixture({ x2: speaker("bot-alice", "Alice") })))
      .toBe("waiting for Alice to finish its turn in this room");
  });

  it("says another room, without naming it, when the hand-off's own teammate speaks there, not a sibling thread's speaker", () => {
    expect(roomQueuedReason(node(), fixture({ x1: speaker("bot-alice", "Alice"), y1: speaker("bot-bob", "Bob") })))
      .toBe("waiting for Bob to finish its turn in another room");
  });

  it("names the teammate's own turn in this room when it is another thread of the same room", () => {
    expect(roomQueuedReason(node(), fixture({ x1: speaker("bot-bob", "Bob") })))
      .toBe("waiting for Bob to finish its turn in this room");
  });

  it("keeps the caller's generic line when only another member speaks, or nobody does", () => {
    expect(roomQueuedReason(node(), fixture({ x1: speaker("bot-alice", "Alice") }))).toBeUndefined();
    expect(roomQueuedReason(node(), fixture({}))).toBeUndefined();
  });

  it("leaves a non-room hand-off, and a room that is gone, to the caller", () => {
    expect(roomQueuedReason(node({ groupId: undefined }), fixture({ x2: speaker("bot-alice", "Alice") }))).toBeUndefined();
    expect(roomQueuedReason(node({ groupId: "gone" }), fixture({ x2: speaker("bot-alice", "Alice") }))).toBeUndefined();
  });
});
