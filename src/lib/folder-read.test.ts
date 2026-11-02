import { describe, expect, it, vi } from "vitest";
import { initialState, reducer, type AppState, type Bot, type BotAnnouncement, type Message } from "@/state/store";
import { departmentUnread, folderUnreadThreadIds, markDepartmentRead, markFolderRead } from "./folder-read";

const bot: Bot = {
  id: "maus", threadId: "elsewhere", name: "Maus", title: "", description: "", notifications: true,
  color: "green", unread: true, messages: [], modelSelection: { instanceId: "fake", model: "test" },
  projects: [{ id: "archive", name: "Archived" }, { id: "work", name: "Work" }],
  tasks: [
    { threadId: "archive-done", projectId: "archive", title: "Done", createdAt: 1, unread: true },
    { threadId: "archive-waiting", projectId: "archive", title: "Needs approval", createdAt: 2, unread: true, activity: "waiting-on-you", busy: true },
    { threadId: "archive-read", projectId: "archive", title: "Already read", createdAt: 3, unread: false },
    { threadId: "elsewhere", projectId: "work", title: "Other folder", createdAt: 4, unread: true },
    { threadId: "loose", title: "No folder", createdAt: 5, unread: true },
  ],
};

describe("mark folder as read", () => {
  it("targets all unread folder threads, including waiting threads, without crossing folders", () => {
    expect(folderUnreadThreadIds(bot, "archive")).toEqual(["archive-done", "archive-waiting"]);
    expect(folderUnreadThreadIds(bot, "work")).toEqual(["elsewhere"]);
    expect(folderUnreadThreadIds(bot, "missing")).toEqual([]);
    expect(folderUnreadThreadIds({ ...bot, tasks: undefined }, "archive")).toEqual([]);
  });

  it("uses the active unread fallback only for legacy tasks without their own unread field", () => {
    expect(folderUnreadThreadIds({ ...bot, tasks: [{ threadId: bot.threadId, title: "Legacy", createdAt: 0, projectId: "archive" }] }, "archive")).toEqual([bot.threadId]);
    expect(folderUnreadThreadIds({ ...bot, tasks: [{ threadId: bot.threadId, title: "Read", createdAt: 0, projectId: "archive", unread: false }] }, "archive")).toEqual([]);
  });

  it("persists explicit-thread reads in order while retaining navigation, queued input, and pending approvals", async () => {
    const approval: Message = { id: "approval", role: "bot", kind: "options", at: 1, card: { title: "Allow?", subtitle: "", options: ["Allow", "Deny"], requestId: "pending-request" } };
    const owner = { ...bot, messages: [approval] };
    let state: AppState = { ...initialState, bots: [owner], selectedId: owner.id, pendingQueued: { "archive-waiting": [{ queueId: "queued", text: "Follow up" }] } };
    const before = structuredClone(state);
    let current: BotAnnouncement = { ...owner };
    const request = vi.fn(async (_path: string, init?: RequestInit) => {
      const { threadId } = JSON.parse(String(init?.body));
      current = { ...current, tasks: current.tasks!.map((task) => task.threadId === threadId ? { ...task, unread: false } : task) };
      return { bot: current };
    });
    const onRead = vi.fn((updated: BotAnnouncement) => { state = reducer(state, { type: "botPatched", bot: updated }); });
    await markFolderRead(owner, "archive", request, onRead);

    expect(request.mock.calls).toEqual([
      ["/api/bots/maus/read", { method: "POST", body: '{"threadId":"archive-done"}' }],
      ["/api/bots/maus/read", { method: "POST", body: '{"threadId":"archive-waiting"}' }],
    ]);
    expect(onRead.mock.calls.map(([updated]) => updated.tasks!.filter((task) => task.unread).map((task) => task.threadId))).toEqual([
      ["archive-waiting", "elsewhere", "loose"], ["elsewhere", "loose"],
    ]);
    expect(state.selectedId).toBe(before.selectedId);
    expect(state.bots[0]!.threadId).toBe(before.bots[0]!.threadId);
    expect(state.bots[0]!.tasks!.find((task) => task.threadId === "archive-waiting")).toMatchObject({ unread: false, activity: "waiting-on-you", busy: true });
    expect(state.bots[0]!.messages).toEqual(before.bots[0]!.messages);
    expect(state.pendingQueued).toEqual(before.pendingQueued);
    expect(owner).toEqual(before.bots[0]);
  });

  it("keeps confirmed partial reads and surfaces a later persistence failure", async () => {
    const error = new Error("Could not mark this conversation as read");
    const request = vi.fn().mockResolvedValueOnce({ bot }).mockRejectedValueOnce(error);
    const onRead = vi.fn();
    await expect(markFolderRead(bot, "archive", request, onRead)).rejects.toBe(error);
    expect(onRead).toHaveBeenCalledExactlyOnceWith(bot);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not write anything for an empty or already-read folder", async () => {
    const request = vi.fn();
    const onRead = vi.fn();
    await markFolderRead({ ...bot, tasks: bot.tasks!.map((task) => ({ ...task, unread: false })) }, "archive", request, onRead);
    await markFolderRead(bot, "empty", request, onRead);
    expect(request).not.toHaveBeenCalled();
    expect(onRead).not.toHaveBeenCalled();
  });
});

describe("mark a department as read", () => {
  const member = (id: string, section: string | undefined, unread: boolean, extra: Partial<Bot> = {}): Bot => ({
    ...bot, id, threadId: `${id}-main`, section, unread, projects: [],
    tasks: [{ threadId: `${id}-main`, title: "Main", createdAt: 0, unread }, { threadId: `${id}-side`, title: "Side", createdAt: 1, unread }],
    ...extra,
  });
  const bots = [member("ada", "Ops", true), member("ben", "Ops", false), member("cara", "Sales", true), member("dan", "Ops", true, { hidden: true }), member("eve", " Ops ", true)];
  const groups = [
    { id: "standup", unread: true, section: "Ops" }, { id: "quiet", unread: false, section: "Ops" },
    { id: "dm", unread: true, section: "Ops", dm: true }, { id: "deals", unread: true, section: "Sales" },
  ];

  it("covers the department's shown bots with unread conversations and its unread group chats, nothing else", () => {
    const unread = departmentUnread("Ops", bots, groups);
    expect(unread.bots.map((b) => b.id)).toEqual(["ada", "eve"]);
    expect(unread.groups.map((g) => g.id)).toEqual(["standup"]);
    expect(departmentUnread("Nowhere", bots, groups)).toEqual({ bots: [], groups: [] });
  });

  it("reads every conversation of each bot, then each group chat, one request at a time", async () => {
    const calls: string[] = [];
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      calls.push(`${path} ${init?.body ?? ""}`.trim());
      return path.startsWith("/api/groups/") ? { group: { id: "standup", unread: false } } : { bot: { id: "ada" } as BotAnnouncement };
    });
    const read = { bots: [] as string[], groups: [] as string[] };
    await markDepartmentRead(departmentUnread("Ops", bots, groups), request, (b) => read.bots.push(b.id), (g) => read.groups.push(g.id));
    expect(calls).toEqual([
      '/api/bots/ada/read {"threadId":"ada-main"}', '/api/bots/ada/read {"threadId":"ada-side"}',
      '/api/bots/eve/read {"threadId":"eve-main"}', '/api/bots/eve/read {"threadId":"eve-side"}',
      "/api/groups/standup/read",
    ]);
    expect(read.groups).toEqual(["standup"]);
  });

  it("keeps the reads before a failure and reports it", async () => {
    const request = vi.fn(async (path: string) => {
      if (path.includes("eve")) throw new Error("offline");
      return { bot: { id: "ada" } as BotAnnouncement };
    });
    await expect(markDepartmentRead(departmentUnread("Ops", bots, groups), request, () => {}, () => {})).rejects.toThrow("offline");
    expect(request.mock.calls.map(([path]) => path)).toEqual(["/api/bots/ada/read", "/api/bots/ada/read", "/api/bots/eve/read"]);
  });
});

