import { describe, expect, it } from "vitest";
import { roomQueueLabel, roomSpeakerIds, roomThreadQueue, roomThreadSpeakerId, roomThreadWorking, roomThreadsWorkingElsewhere } from "./room-threads";
import type { Group } from "@/state/store";

type Room = Pick<Group, "threadId" | "working" | "busyBotId" | "tasks">;

describe("room thread state", () => {
  // The open thread idles while two others run: the room flag counts every thread, busyBotId only the open one's.
  const room: Room = {
    threadId: "open",
    working: true,
    busyBotId: null,
    tasks: [
      { threadId: "open", title: "Open", createdAt: 1, working: false, busyBotId: null },
      { threadId: "goal", title: "Goal", createdAt: 2, working: true, busyBotId: null },
      { threadId: "draft", title: "Draft", createdAt: 3, working: true, busyBotId: "pixel" },
    ],
  };

  it("reads each thread's own work and speaker, not the room's", () => {
    expect(roomThreadWorking(room, "open")).toBe(false);
    expect(roomThreadWorking(room, "goal")).toBe(true);
    expect(roomThreadWorking(room, "draft")).toBe(true);
    expect(roomThreadSpeakerId(room, "open")).toBeNull();
    expect(roomThreadSpeakerId(room, "draft")).toBe("pixel");
    expect(roomThreadsWorkingElsewhere(room)).toBe(2);
  });

  it("lists every member speaking anywhere in the room once, the open thread's first", () => {
    expect(roomSpeakerIds(room)).toEqual(["pixel"]);
    expect(roomSpeakerIds({
      ...room,
      busyBotId: "scout",
      tasks: [
        { threadId: "open", title: "Open", createdAt: 1, working: true, busyBotId: "scout" },
        { threadId: "draft", title: "Draft", createdAt: 3, working: true, busyBotId: "pixel" },
      ],
    })).toEqual(["scout", "pixel"]);
  });

  it("falls back to the room's own fields for a server that ran one thread at a time", () => {
    const legacy: Room = {
      threadId: "open",
      working: true,
      busyBotId: "scout",
      tasks: [
        { threadId: "open", title: "Open", createdAt: 1 },
        { threadId: "other", title: "Other", createdAt: 2 },
      ],
    };
    expect(roomThreadWorking(legacy, "open")).toBe(true);
    expect(roomThreadWorking(legacy, "other")).toBe(false);
    expect(roomThreadSpeakerId(legacy, "open")).toBe("scout");
    expect(roomThreadSpeakerId(legacy, "other")).toBeNull();
    expect(roomThreadsWorkingElsewhere(legacy)).toBe(0);
    expect(roomThreadWorking({ threadId: "dm", working: true }, "dm")).toBe(true);
  });
});

describe("room queue labels", () => {
  const queue = [
    { botId: "scout", threadId: "open", state: "running" as const, position: 1, of: 3 },
    { botId: "pixel", threadId: "open", state: "queued" as const, position: 2, of: 3, waitingForBotId: "scout" },
    { botId: "ada", threadId: "other", state: "queued" as const, position: 2, of: 2 },
  ];

  it("lists only the open thread's waiting members and says on whom they wait", () => {
    const waiting = roomThreadQueue({ queue }, "open");
    expect(waiting.map((entry) => entry.botId)).toEqual(["pixel"]);
    expect(roomQueueLabel(waiting[0]!, (id) => (id === "scout" ? "Scout" : undefined))).toBe("Queued · waiting for Scout (2 of 3)");
    expect(roomQueueLabel(roomThreadQueue({ queue }, "other")[0]!, () => undefined)).toBe("Queued (2 of 2)");
    expect(roomThreadQueue({}, "open")).toEqual([]);
  });
});
