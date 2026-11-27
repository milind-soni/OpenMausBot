import { describe, expect, it, vi } from "vitest";
import { initialState, reducer, type AppState, type Bot, type BotAnnouncement, type Message } from "@/state/store";
import { botUnreadThreadIds, markBotRead } from "./folder-read";

const owner: Bot = {
  id: "reviewer", threadId: "selected", name: "Reviewer", title: "", description: "", notifications: true,
  color: "green", unread: true, messages: [], modelSelection: { instanceId: "fake", model: "test" },
  tasks: [
    { threadId: "selected", title: "Selected", createdAt: 1, unread: true },
    { threadId: "filed", title: "Filed report", projectId: "reports", createdAt: 2, unread: true },
    { threadId: "working", title: "Working report", createdAt: 3, unread: true, busy: true, activity: "working" },
    { threadId: "approval", title: "Approval", createdAt: 4, unread: true, busy: true, activity: "waiting-on-you" },
    { threadId: "archived", title: "Archived", createdAt: 5, unread: true, archivedAt: 10 },
    { threadId: "already-read", title: "Read", createdAt: 6, unread: false },
  ],
};

describe("mark all bot conversations as read", () => {
  it("includes unfiled, filed, working, waiting and archived threads, excluding already-read threads", () => {
    expect(botUnreadThreadIds(owner)).toEqual(["selected", "filed", "working", "approval", "archived"]);
  });

  it("supports a legacy bot without tasks and respects an explicit false task flag", () => {
    expect(botUnreadThreadIds({ ...owner, tasks: undefined })).toEqual(["selected"]);
    expect(botUnreadThreadIds({ ...owner, tasks: [], unread: false })).toEqual([]);
    expect(botUnreadThreadIds({ ...owner, tasks: [{ threadId: "selected", title: "Read", createdAt: 1, unread: false }] })).toEqual([]);
    expect(botUnreadThreadIds({ ...owner, tasks: [{ threadId: "selected", title: "Legacy", createdAt: 1 }] })).toEqual(["selected"]);
  });

  it("uses explicit-thread reads in order and preserves selection, history, model, work, queues and approvals", async () => {
    const approval: Message = { id: "card", role: "bot", kind: "options", at: 1, card: { title: "Allow?", subtitle: "", options: ["Allow", "Deny"], requestId: "pending" } };
    const bot = { ...owner, messages: [approval] };
    const other = { ...owner, id: "other-reviewer", threadId: "other-selected" };
    let state: AppState = { ...initialState, bots: [bot, other], selectedId: other.id,
      pendingQueued: { working: [{ queueId: "queued", text: "Follow up" }] } };
    const before = structuredClone(state);
    let current: BotAnnouncement = { ...bot };
    const request = vi.fn(async (_path: string, init?: RequestInit) => {
      const { threadId } = JSON.parse(String(init?.body));
      current = { ...current, unread: false, tasks: current.tasks!.map((task) => task.threadId === threadId ? { ...task, unread: false } : task) };
      return { bot: current };
    });
    await markBotRead(bot, request, (updated) => { state = reducer(state, { type: "botPatched", bot: updated }); });
    expect(request.mock.calls.map(([path, init]) => [path, JSON.parse(String(init?.body)).threadId])).toEqual(
      ["selected", "filed", "working", "approval", "archived"].map((id) => ["/api/bots/reviewer/read", id]),
    );
    expect(state.bots[0]!.tasks!.every((task) => !task.unread)).toBe(true);
    expect(state.bots[0]!.threadId).toBe(before.bots[0]!.threadId);
    expect(state.selectedId).toBe(before.selectedId);
    expect(state.bots[0]!.messages).toEqual(before.bots[0]!.messages);
    expect(state.bots[0]!.modelSelection).toEqual(before.bots[0]!.modelSelection);
    expect(state.bots[0]!.tasks!.find((task) => task.threadId === "working")).toMatchObject({ busy: true, activity: "working" });
    expect(state.bots[0]!.tasks!.find((task) => task.threadId === "approval")).toMatchObject({ busy: true, activity: "waiting-on-you" });
    expect(state.pendingQueued).toEqual(before.pendingQueued);
    expect(state.bots[1]).toEqual(before.bots[1]);
    expect(bot).toEqual(before.bots[0]);
  });

  it("retains partial success after failure and retries only the remaining unread threads", async () => {
    const error = new Error("Read failed");
    const partial = { ...owner, tasks: owner.tasks!.map((task) => task.threadId === "selected" ? { ...task, unread: false } : task) };
    const request = vi.fn().mockResolvedValueOnce({ bot: partial }).mockRejectedValueOnce(error);
    const onRead = vi.fn();
    await expect(markBotRead(owner, request, onRead)).rejects.toBe(error);
    expect(onRead).toHaveBeenCalledExactlyOnceWith(partial);
    expect(request).toHaveBeenCalledTimes(2);
    const retry = vi.fn().mockResolvedValue({ bot: partial });
    await markBotRead(partial, retry, onRead);
    expect(retry.mock.calls.map(([, init]) => JSON.parse(String(init.body)).threadId)).toEqual(["filed", "working", "approval", "archived"]);
  });

  it("does not extend the initial snapshot to new threads arriving during the read", async () => {
    const bot = structuredClone(owner);
    const request = vi.fn(async () => {
      bot.tasks!.push({ threadId: "new-arrival", title: "New report", createdAt: 100, unread: true });
      return { bot };
    });
    await markBotRead(bot, request, vi.fn());
    expect(request).toHaveBeenCalledTimes(5);
    expect(bot.tasks!.find((task) => task.threadId === "new-arrival")?.unread).toBe(true);
  });

  it("handles hundreds of background threads without parallel requests", async () => {
    const bot = { ...owner, tasks: Array.from({ length: 250 }, (_, i) => ({ threadId: `report-${i}`, title: "Report", createdAt: i, unread: true })) };
    let active = 0, maximum = 0;
    const request = vi.fn(async () => {
      active++; maximum = Math.max(maximum, active);
      await Promise.resolve(); active--;
      return { bot };
    });
    await markBotRead(bot, request, vi.fn());
    expect(request).toHaveBeenCalledTimes(250);
    expect(maximum).toBe(1);
  });

  it("does not write anything when every thread is already read", async () => {
    const request = vi.fn();
    await markBotRead({ ...owner, unread: false, tasks: owner.tasks!.map((task) => ({ ...task, unread: false })) }, request, vi.fn());
    expect(request).not.toHaveBeenCalled();
  });
});
