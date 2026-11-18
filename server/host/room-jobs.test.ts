import { describe, expect, it } from "vitest";

import type { AppConfig } from "../config.ts";
import type { HandoffView } from "../coordinator.ts";
import type { Store } from "../store.ts";
import { createRoomJobs, parallelRoomJobsEnabled } from "./room-jobs.ts";

// Room members work side by side unless the server opts out.
describe("parallelRoomJobsEnabled", () => {
  it("is on when the config leaves it out", () => {
    expect(parallelRoomJobsEnabled({} as AppConfig)).toBe(true);
    expect(parallelRoomJobsEnabled({ features: {} } as AppConfig)).toBe(true);
  });

  it("stays off when the config sets it to false", () => {
    expect(parallelRoomJobsEnabled({ features: { parallelRoomJobs: false } } as AppConfig)).toBe(false);
  });
});

describe("laneBulletin", () => {
  const rooms: Record<string, { name: string; bulletin: string }> = {
    "room-thread": { name: "Studio", bulletin: "  Synthetic data only.  " },
    "quiet-thread": { name: "Quiet", bulletin: "" },
  };
  const store = { groupByThread: (threadId: string) => rooms[threadId] } as unknown as Store;
  const lanes: Record<string, string> = { lane: "room-thread", "quiet-lane": "quiet-thread" };
  const { laneBulletin } = createRoomJobs({ store, coordinator: { active: () => [] }, cfg: {} as AppConfig,
    operations: () => [], speakerOf: () => undefined, laneRoomThread: n => lanes[n.threadId] });

  it("carries the room's bulletin into a job running beside it", () => {
    expect(laneBulletin({ botId: "b", threadId: "lane" })).toBe('Room bulletin of "Studio" (shared instructions for everyone):\nSynthetic data only.');
  });

  it("adds nothing for other threads or a room without a bulletin", () => {
    expect(laneBulletin({ botId: "b", threadId: "work" })).toBe("");
    expect(laneBulletin({ botId: "b", threadId: "quiet-lane" })).toBe("");
  });
});

type Operation = { threadId: string; cancelled: boolean; botIds: Set<string>; line?: { current?: string; pending: string[] } };
type Room = { id: string; name: string; threadId: string; busyBotId?: string | null };

function setup(input: { rooms: Room[]; operations?: Record<string, Operation[]>; busyThreads?: Record<string, string[]>; running?: string[]; speakers?: Record<string, string>; jobs: Partial<HandoffView>[] }) {
  const running = new Set([...(input.running ?? []), ...Object.keys(input.busyThreads ?? {})]);
  const store = {
    groups: input.rooms,
    bot: (botId: string) => ({ id: botId, busy: running.has(botId) }),
    tasks: (botId: string) => (input.busyThreads?.[botId] ?? []).map((threadId) => ({ threadId, title: threadId, busy: true })),
  } as unknown as Store;
  const active = input.jobs.map((job, index) => ({ id: `job-${index}`, parentId: "lead-turn", status: "queued", createdAt: index, ...job }) as HandoffView);
  return createRoomJobs({
    store, cfg: {} as AppConfig, coordinator: { active: () => active },
    operations: (groupId) => input.operations?.[groupId] ?? [], speakerOf: (threadId) => input.speakers?.[threadId], laneRoomThread: () => undefined,
  });
}

describe("a room's queue names where a waiting member is busy", () => {
  const rooms: Room[] = [{ id: "room-1", name: "Group 1", threadId: "g1" }, { id: "room-2", name: "Group 2", threadId: "g2" }];
  const handedIn2 = { botId: "coder", groupId: "room-2", threadId: "g2" };

  it("marks a member queued here while its turn runs in another room", () => {
    const jobs = setup({ rooms, running: ["coder"], speakers: { g1: "coder" }, operations: { "room-1": [{ threadId: "g1", cancelled: false, botIds: new Set(["coder"]) }] }, jobs: [handedIn2] });
    expect(jobs.roomLineOf(rooms[1] as never)).toEqual([
      { botId: "coder", threadId: "g2", state: "queued", position: 1, of: 1, assignmentId: "job-0", busyIn: { groupId: "room-1", threadId: "g1" } },
    ]);
  });

  it("marks one busy in a thread of its own, and no place when it is free or only this room holds it", () => {
    expect(setup({ rooms, busyThreads: { coder: ["own-chat"] }, jobs: [handedIn2] }).roomLineOf(rooms[1] as never)[0]?.busyIn)
      .toEqual({ threadId: "own-chat" });
    expect(setup({ rooms, jobs: [handedIn2] }).roomLineOf(rooms[1] as never)[0]?.busyIn).toBeUndefined();
    const sameRoom = setup({ rooms, running: ["coder"], operations: { "room-2": [{ threadId: "g2", cancelled: false, botIds: new Set(["coder"]) }] }, jobs: [handedIn2] });
    expect(sameRoom.roomLineOf(rooms[1] as never)[0]?.busyIn).toBeUndefined();
    const cancelled = setup({ rooms, running: ["coder"], operations: { "room-1": [{ threadId: "g1", cancelled: true, botIds: new Set(["coder"]) }] }, jobs: [handedIn2] });
    expect(cancelled.roomLineOf(rooms[1] as never)[0]?.busyIn).toBeUndefined();
  });

  it("names only the place a member is running: the host holds room hand-offs on that, not on a later turn in another room's round", () => {
    const pendingInRoom1 = { "room-1": [{ threadId: "g1", cancelled: false, botIds: new Set(["scout", "coder"]), line: { current: "scout", pending: ["coder"] } }] };
    // Only waiting for its turn in Group 1's round, not running: this room does not wait on Group 1.
    expect(setup({ rooms, operations: pendingInRoom1, jobs: [handedIn2] }).roomLineOf(rooms[1] as never)[0]?.busyIn).toBeUndefined();
    // Waiting in Group 1's round while it runs in Group 3: Group 3 is where it is busy.
    const three = [...rooms, { id: "room-3", name: "Group 3", threadId: "g3", busyBotId: "coder" }];
    expect(setup({ rooms: three, running: ["coder"], operations: pendingInRoom1, jobs: [handedIn2] }).roomLineOf(three[1] as never)[0]?.busyIn)
      .toEqual({ groupId: "room-3", threadId: "g3" });
  });

  it("does not name a room whose turn for the member has not started yet", () => {
    const queuedInRoom1 = { "room-1": [{ threadId: "g1", cancelled: false, botIds: new Set(["coder"]) }] };
    expect(setup({ rooms, busyThreads: { coder: ["own-chat"] }, operations: queuedInRoom1, jobs: [handedIn2] }).roomLineOf(rooms[1] as never)[0]?.busyIn)
      .toEqual({ threadId: "own-chat" });
  });
});
