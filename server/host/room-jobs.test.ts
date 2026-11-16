import { describe, expect, it } from "vitest";

import type { AppConfig } from "../config.ts";
import type { HandoffView } from "../coordinator.ts";
import type { Store } from "../store.ts";
import { createRoomJobs } from "./room-jobs.ts";

type Operation = { threadId: string; cancelled: boolean; botIds: Set<string> };
type Room = { id: string; name: string; threadId: string; busyBotId?: string | null };

function setup(input: { rooms: Room[]; operations?: Record<string, Operation[]>; busyThreads?: Record<string, string[]>; jobs: Partial<HandoffView>[] }) {
  const store = {
    groups: input.rooms,
    tasks: (botId: string) => (input.busyThreads?.[botId] ?? []).map((threadId) => ({ threadId, title: threadId, busy: true })),
  } as unknown as Store;
  const active = input.jobs.map((job, index) => ({ id: `job-${index}`, parentId: "lead-turn", status: "queued", createdAt: index, ...job }) as HandoffView);
  return createRoomJobs({
    store, cfg: {} as AppConfig, coordinator: { active: () => active },
    operations: (groupId) => input.operations?.[groupId] ?? [], speakerOf: () => undefined, laneRoomThread: () => undefined,
  });
}

describe("a room's queue names where a waiting member is busy", () => {
  const rooms: Room[] = [{ id: "room-1", name: "Group 1", threadId: "g1" }, { id: "room-2", name: "Group 2", threadId: "g2" }];
  const handedIn2 = { botId: "coder", groupId: "room-2", threadId: "g2" };

  it("marks a member queued here while its turn runs in another room", () => {
    const jobs = setup({ rooms, operations: { "room-1": [{ threadId: "g1", cancelled: false, botIds: new Set(["coder"]) }] }, jobs: [handedIn2] });
    expect(jobs.roomLineOf(rooms[1] as never)).toEqual([
      { botId: "coder", threadId: "g2", state: "queued", position: 1, of: 1, assignmentId: "job-0", busyIn: { groupId: "room-1", threadId: "g1" } },
    ]);
  });

  it("marks one busy in a thread of its own, and no place when it is free or only this room holds it", () => {
    expect(setup({ rooms, busyThreads: { coder: ["own-chat"] }, jobs: [handedIn2] }).roomLineOf(rooms[1] as never)[0]?.busyIn)
      .toEqual({ threadId: "own-chat" });
    expect(setup({ rooms, jobs: [handedIn2] }).roomLineOf(rooms[1] as never)[0]?.busyIn).toBeUndefined();
    const sameRoom = setup({ rooms, operations: { "room-2": [{ threadId: "g2", cancelled: false, botIds: new Set(["coder"]) }] }, jobs: [handedIn2] });
    expect(sameRoom.roomLineOf(rooms[1] as never)[0]?.busyIn).toBeUndefined();
    const cancelled = setup({ rooms, operations: { "room-1": [{ threadId: "g1", cancelled: true, botIds: new Set(["coder"]) }] }, jobs: [handedIn2] });
    expect(cancelled.roomLineOf(rooms[1] as never)[0]?.busyIn).toBeUndefined();
  });
});
