import { describe, expect, it, vi } from "vitest";
import { lastHumanRoomMessageAt, newThreadTitle, postToRoomThread } from "./room-post-thread.ts";
import type { GroupRecord, GroupTaskRecord, Message } from "./store.ts";

const room = (threadIds: string[]) => ({
  id: "room", threadId: threadIds[0], tasks: threadIds.map((threadId) => ({ threadId, title: threadId, createdAt: 1 })),
}) as unknown as GroupRecord;
const line = (at: number, extra: Partial<Message> = {}): Message => ({ id: `m${at}`, at, role: "user", kind: "text", text: "hi", ...extra });
const post: Omit<Message, "id" | "at"> = { role: "bot", kind: "text", text: "Kickoff." };

describe("newThreadTitle", () => {
  it("reads no title as no new thread, and refuses one that is blank, too long, two lines or not text", () => {
    expect(newThreadTitle(undefined)).toBeUndefined();
    expect(newThreadTitle("  Q4 launch ")).toBe("Q4 launch");
    for (const bad of ["   ", "x".repeat(81), "one\ntwo", 42, null]) expect(newThreadTitle(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe("lastHumanRoomMessageAt", () => {
  it("takes the person's latest line across every thread, never a bot's or one stamped through the API", () => {
    const transcripts: Record<string, Message[]> = {
      one: [line(5), line(40, { role: "bot" })],
      two: [line(30), line(90, { via: "api" })],
      three: [],
    };
    const store = { messagesFor: (threadId: string) => transcripts[threadId] ?? [] };
    expect(lastHumanRoomMessageAt(store, room(["one", "two", "three"]))).toBe(30);
    expect(lastHumanRoomMessageAt(store, room(["three"]))).toBeUndefined();
  });

  it("handles a room with more threads than a spread call takes", () => {
    const threads = Array.from({ length: 200_000 }, (_, index) => `t${index}`);
    expect(lastHumanRoomMessageAt({ messagesFor: (threadId) => threadId === "t199999" ? [line(7)] : [] }, room(threads))).toBe(7);
  });
});

describe("postToRoomThread", () => {
  const opened = { threadId: "new", title: "Q4 launch", createdAt: 1 } as GroupTaskRecord;

  it("posts into the room's open thread, or into the thread it opens", () => {
    const store = { createGroupTask: vi.fn(() => opened), appendMessage: vi.fn((threadId: string) => line(1, { id: threadId })), deleteGroupTask: vi.fn() };
    expect(postToRoomThread(store as never, room(["open"]), undefined, post)?.posted.id).toBe("open");
    expect(postToRoomThread(store as never, room(["open"]), "Q4 launch", post)).toMatchObject({ opened, posted: { id: "new" } });
    expect(store.createGroupTask).toHaveBeenCalledWith("room", "Q4 launch", false);
  });

  it("removes the thread it opened when the post cannot be saved, and passes the failure on", () => {
    const failure = new Error("disk full");
    const store = { createGroupTask: vi.fn(() => opened), appendMessage: vi.fn(() => { throw failure; }), deleteGroupTask: vi.fn() };
    expect(() => postToRoomThread(store as never, room(["open"]), "Q4 launch", post)).toThrow(failure);
    expect(store.deleteGroupTask).toHaveBeenCalledWith("room", "new");
  });

  it("still passes on the post's failure when removing the empty thread fails too", () => {
    const failure = new Error("disk full");
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const store = { createGroupTask: vi.fn(() => opened), appendMessage: vi.fn(() => { throw failure; }), deleteGroupTask: vi.fn(() => { throw new Error("locked"); }) };
      expect(() => postToRoomThread(store as never, room(["open"]), "Q4 launch", post)).toThrow(failure);
      expect(quiet).toHaveBeenCalledWith(expect.stringContaining("new"), expect.objectContaining({ message: "locked" }));
    } finally {
      quiet.mockRestore();
    }
  });

  it("opens nothing and posts nothing when the room can no longer take a thread", () => {
    const store = { createGroupTask: vi.fn(() => null), appendMessage: vi.fn(), deleteGroupTask: vi.fn() };
    expect(postToRoomThread(store as never, room(["open"]), "Q4 launch", post)).toBeNull();
    expect(store.appendMessage).not.toHaveBeenCalled();
  });
});
