import { describe, expect, it, vi } from "vitest";

import { createRoomSpeakers, forgetStaleSpeakers, ROOM_SPEAKER_GRACE_MS, type RoomSpeaker } from "./room-speaker.ts";

const speaker = (over: Partial<RoomSpeaker> = {}): RoomSpeaker => ({ botId: "bot-ada", name: "Ada", color: "blue", since: 0, ...over });

function fixture(speakers: Array<[string, RoomSpeaker]>, live: { engine?: string[]; liveTurn?: string[]; settling?: string[]; operation?: string[]; busy?: string[]; now?: number; graceMs?: number } = {}) {
  const map = new Map(speakers);
  const forget = vi.fn();
  const forgotten = forgetStaleSpeakers(map, {
    engine: (threadId) => (live.engine ?? []).includes(threadId),
    liveTurn: (threadId) => (live.liveTurn ?? []).includes(threadId),
    settling: (threadId) => (live.settling ?? []).includes(threadId),
    operation: (threadId) => (live.operation ?? []).includes(threadId),
    botBusy: (botId) => (live.busy ?? []).includes(botId),
    now: () => live.now ?? ROOM_SPEAKER_GRACE_MS,
    ...(live.graceMs === undefined ? {} : { graceMs: live.graceMs }),
    forget,
  });
  return { map, forget, forgotten };
}

describe("a room's stale speaker", () => {
  it("keeps an entry while its engine, live turn, settling turn, operation, or bot still holds the room", () => {
    for (const live of [{ engine: ["t1"] }, { liveTurn: ["t1"] }, { settling: ["t1"] }, { operation: ["t1"] }, { busy: ["bot-ada"] }]) {
      const { map, forget } = fixture([["t1", speaker()]], live);
      expect(map.has("t1"), JSON.stringify(live)).toBe(true);
      expect(forget).not.toHaveBeenCalled();
    }
  });

  it("keeps an entry through setup, and one with no recorded start, rather than guessing", () => {
    expect(fixture([["t1", speaker({ since: 900 })]], { now: 1_000 }).forgotten).toEqual([]);
    expect(fixture([["t1", speaker({ since: undefined })]], { now: 1e9 }).forgotten).toEqual([]);
  });

  it("forgets an entry with nothing live once its grace has passed", () => {
    const { map, forget, forgotten } = fixture([["t1", speaker({ since: 0 })]], { now: ROOM_SPEAKER_GRACE_MS });
    expect(forgotten).toEqual([{ threadId: "t1", speaker: speaker({ since: 0 }) }]);
    expect(map.has("t1")).toBe(false);
    expect(forget).toHaveBeenCalledExactlyOnceWith("t1", speaker({ since: 0 }));
  });

  it("forgets only the stale entries, and honours a caller's grace", () => {
    const { map, forgotten } = fixture([
      ["stale", speaker({ since: 0 })],
      ["live", speaker({ botId: "bot-ops", since: 0 })],
      ["recent", speaker({ botId: "bot-kim", since: 980 })],
    ], { busy: ["bot-ops"], now: 1_000, graceMs: 50 });
    expect(forgotten.map((entry) => entry.threadId)).toEqual(["stale"]);
    expect([...map.keys()]).toEqual(["live", "recent"]);
  });
});

describe("a room's speaker registry", () => {
  const NOW = 1_000_000;
  function registry() {
    const speakers = new Map<string, RoomSpeaker>();
    const operations = new Map<string, Set<{ cancelled: boolean; threadId: string }>>();
    const groups = new Map([["room-1", { id: "room-1", threadId: "room-main" }]]);
    const tasks = new Map([["room-1", [{ threadId: "room-task" }]]]);
    const forget = vi.fn();
    const rooms = createRoomSpeakers({
      speakers, operations, forget,
      group: (id) => groups.get(id),
      groupTasks: (id) => tasks.get(id) ?? [],
      groupByThread: (threadId) => [...groups.values()].find((group) => group.threadId === threadId || (tasks.get(group.id) ?? []).some((task) => task.threadId === threadId)),
      engine: () => false, liveTurn: () => false, settling: () => false, botBusy: () => false, now: () => NOW,
    });
    return { speakers, operations, forget, rooms };
  }

  it("holds a room thread for its speaker or for work still running on it, never for cancelled work", () => {
    const { speakers, operations, rooms } = registry();
    expect(rooms.working("room-1", "room-main")).toBe(false);
    speakers.set("room-main", speaker({ since: NOW }));
    expect(rooms.working("room-1", "room-main")).toBe(true);
    speakers.clear();
    operations.set("room-1", new Set([{ cancelled: true, threadId: "room-main" }]));
    expect(rooms.working("room-1", "room-main")).toBe(false);
    operations.get("room-1")!.add({ cancelled: false, threadId: "room-main" });
    expect(rooms.working("room-1", "room-main")).toBe(true);
  });

  it("names the main thread's speaker first, then a task thread's", () => {
    const { speakers, rooms } = registry();
    expect(rooms.active("room-1")).toBeUndefined();
    const task = speaker({ botId: "bot-ops" });
    speakers.set("room-task", task);
    expect(rooms.active("room-1")).toEqual(task);
    const main = speaker({ botId: "bot-ada" });
    speakers.set("room-main", main);
    expect(rooms.active("room-1")).toEqual(main);
    expect(rooms.active("no-such-room")).toBeUndefined();
  });

  it("drops a stale speaker and hands the room to whoever still holds it", () => {
    const { speakers, forget, rooms } = registry();
    const stale = speaker({ since: 0 });
    const remaining = speaker({ botId: "bot-ops", since: NOW });
    speakers.set("room-main", stale);
    speakers.set("room-task", remaining);
    expect(rooms.forgetStale()).toBe(1);
    expect(speakers.has("room-main")).toBe(false);
    expect(speakers.get("room-task")).toEqual(remaining);
    expect(forget).toHaveBeenCalledExactlyOnceWith("room-main", "room-1", stale, remaining);
  });

  it("drops a speaker for a thread no room owns, without inventing a room to report", () => {
    const { speakers, forget, rooms } = registry();
    speakers.set("orphan", speaker({ since: 0 }));
    expect(rooms.forgetStale()).toBe(1);
    expect(speakers.has("orphan")).toBe(false);
    expect(forget).not.toHaveBeenCalled();
  });
});
