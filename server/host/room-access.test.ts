import { describe, expect, it } from "vitest";

import type { BotRecord, Store } from "../store.ts";
import { createRoomAccess } from "./room-access.ts";

// Only a thread opened as a parallel room job answers to its room; a work
// thread a room conversation opened for anything else does not.
describe("laneRoomThread", () => {
  const tasks: Record<string, { openedBy?: Record<string, unknown> }> = {
    lane: { openedBy: { botId: "lead", name: "Lead", kind: "work", threadId: "room-thread", roomLane: true, at: 1 } },
    work: { openedBy: { botId: "lead", name: "Lead", kind: "work", threadId: "room-thread", at: 1 } },
  };
  const store = {
    taskByThread: (_botId: string, threadId: string) => tasks[threadId],
    groupByThread: (threadId: string) => threadId === "room-thread" ? { id: "room" } : undefined,
  } as unknown as Store;
  const { laneRoomThread } = createRoomAccess({ store });

  it("names the room thread of a parallel room job only", () => {
    expect(laneRoomThread({ botId: "e1", threadId: "lane" })).toBe("room-thread");
    expect(laneRoomThread({ botId: "e1", threadId: "work" })).toBeUndefined();
    expect(laneRoomThread({ botId: "e1", threadId: "lane", groupId: "room" })).toBeUndefined();
  });
});

describe("roomTalks", () => {
  const bots = {
    insider: { id: "insider", name: "Insider", section: "Build" },
    stranger: { id: "stranger", name: "Stranger", section: "Elsewhere" },
  } as unknown as Record<string, BotRecord>;
  const store = {
    bot: (id: string) => bots[id],
    messagesFor: () => [],
  } as unknown as Store;
  const { roomTalks } = createRoomAccess({ store });
  const room = (over: Record<string, unknown> = {}) => ({
    id: "room", threadId: "room-thread", dm: false, memberIds: ["insider"], name: "Room", ...over,
  }) as never;

  it("returns one discriminated problem per rule", () => {
    expect(roomTalks(bots.insider!, room())).toEqual({ ok: true });
    expect(roomTalks(bots.insider!, room({ dm: true, threadId: "dm-thread" }))).toEqual({ ok: false, problem: "dm" });
    expect(roomTalks(bots.stranger!, room({ memberIds: ["insider"] }))).toEqual({ ok: false, problem: "not-member" });
    expect(roomTalks(bots.insider!, room({ memberIds: ["insider", "stranger"] }))).toEqual({ ok: true });
    expect(roomTalks(bots.insider!, room({ setupCompletedAt: null, setupSkippedAt: null })))
      .toEqual({ ok: false, problem: "setup" });
    expect(roomTalks(bots.insider!, room({ setupCompletedAt: 1 }))).toEqual({ ok: true });
  });
});

