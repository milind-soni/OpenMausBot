import { describe, expect, it, vi } from "vitest";
import type { Action } from "@/state/store";
import { startFeedThread } from "./start-thread";

type SendGroup = Extract<Action, { type: "sendGroup" }>;
const send = (extra: Partial<SendGroup> = {}): SendGroup => ({ type: "sendGroup", groupId: "room", text: "Plan the launch", sendId: `s-${Math.random()}`, threadId: "feed-room", mode: "chat", ...extra });

describe("a line sent from the room feed", () => {
  it("makes a thread without making it the room's current one, opens it beside the feed, then sends there", async () => {
    const request = vi.fn(async () => ({ group: { id: "room", threadId: "current" }, task: { threadId: "new" } }));
    const dispatch = vi.fn();
    const line = send();
    expect(await startFeedThread(line, dispatch, request as never)).toBe("new");
    expect(request).toHaveBeenCalledWith("/api/groups/room/tasks", { method: "POST", body: JSON.stringify({ activate: false }) });
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "groupPatched", group: { id: "room", threadId: "current" } },
      { type: "openForkPanel", kind: "group", ownerId: "room", threadId: "new" },
      { ...line, threadId: "new" },
    ]);
    expect(dispatch.mock.calls.some(([action]) => action.type === "switchGroupTask" || action.type === "newGroupTask")).toBe(false);
  });

  it("writes a retried send to the thread it already started", async () => {
    const request = vi.fn(async () => ({ task: { threadId: "made-once" } }));
    const line = send();
    await startFeedThread(line, vi.fn(), request as never);
    const dispatch = vi.fn();
    expect(await startFeedThread(line, dispatch, request as never)).toBe("made-once");
    expect(request).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenLastCalledWith({ ...line, threadId: "made-once" });
  });

  it("gives the draft back and says so when the thread can't be made", async () => {
    const onError = vi.fn();
    const dispatch = vi.fn();
    expect(await startFeedThread(send({ onError }), dispatch, (async () => { throw new Error("offline"); }) as never)).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith({ type: "error", message: "Couldn't start a thread. Check your connection and try again." });
    expect(dispatch.mock.calls.some(([action]) => action.type === "sendGroup")).toBe(false);
  });
});
