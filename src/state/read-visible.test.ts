import { describe, expect, it } from "vitest";
import { holdMarkedUnread, markVisibleBotThreadsRead, markVisibleGroupThreadsRead } from "./read-visible";
import type { Action, AppState, BotAnnouncement, Group } from "./store";

it("marks both visible bot threads read while leaving a hidden task unread", () => {
  const bot = { id: "bot", unread: true, tasks: [
    { threadId: "main", unread: true, updatedAt: 10 }, { threadId: "fork", unread: true, updatedAt: 20 }, { threadId: "hidden", unread: true },
  ] } as unknown as BotAnnouncement;
  const state = { selectedId: "bot", activeView: "chat", bots: [{ id: "bot", threadId: "main" }],
    forkPanel: { kind: "bot", ownerId: "bot", threadId: "fork" } } as unknown as AppState;
  const read: Array<[string, number]> = [];
  markVisibleBotThreadsRead(state, bot, true, (_path, threadId, updatedAt) => read.push([threadId, updatedAt]));
  expect(read).toEqual([["main", 10], ["fork", 20]]);
  expect(bot.tasks?.map((task) => task.unread)).toEqual([false, false, true]);
  expect(bot.unread).toBe(true);
});

it("marks the main room and its open fork read", () => {
  const group = { id: "room", unread: true, tasks: [
    { threadId: "main", unread: true }, { threadId: "fork", unread: true }, { threadId: "hidden", unread: true },
  ] } as Partial<Group> & { id: string };
  const state = { selectedId: "room", activeView: "chat", groups: [{ id: "room", threadId: "main" }],
    forkPanel: { kind: "group", ownerId: "room", threadId: "fork" } } as unknown as AppState;
  const read: string[] = [];
  markVisibleGroupThreadsRead(state, group, true, (_path, threadId) => read.push(threadId));
  expect(read).toEqual(["main", "fork"]);
  expect(group.tasks?.map((task) => task.unread)).toEqual([false, false, true]);
  expect(group.unread).toBe(true);
});

describe("a conversation marked unread while it is open", () => {
  const open = (updatedAt: number | null = 10) => ({ selectedId: "bot", activeView: "chat", forkPanel: null,
    bots: [{ id: "bot", threadId: "main", tasks: [{ threadId: "main", updatedAt: updatedAt ?? undefined }] }, { id: "other", threadId: "elsewhere" }] }) as unknown as AppState;
  const announced = (updatedAt = 10, id = "bot", threadId = "main") =>
    ({ id, unread: true, tasks: [{ threadId, unread: true, updatedAt }] }) as unknown as BotAnnouncement;
  const seen = (state: AppState, bot: BotAnnouncement) => {
    const read: string[] = [];
    markVisibleBotThreadsRead(state, bot, true, (_path, threadId) => read.push(threadId));
    return { read, unread: bot.unread, thread: bot.tasks?.[0]?.unread };
  };
  const mark = (state: AppState, botId = "bot") => holdMarkedUnread({ type: "markUnread", botId }, state);
  const act = (action: unknown, state: AppState) => holdMarkedUnread(action as Action, state);

  it("stays unread however often the server announces it", () => {
    const state = open();
    mark(state);
    expect(seen(state, announced())).toEqual({ read: [], unread: true, thread: true });
    expect(seen(state, announced())).toEqual({ read: [], unread: true, thread: true });
    act({ type: "select", id: "bot" }, state);
  });

  it("is read again once a newer message is seen", () => {
    const state = open();
    mark(state);
    expect(seen(state, announced()).read).toEqual([]);
    expect(seen(state, announced(11))).toEqual({ read: ["main"], unread: false, thread: false });
    expect(seen(state, announced(11)).read).toEqual(["main"]);
  });

  it("takes the first announcement as its newest message when the app knows no time for it", () => {
    const state = open(null);
    mark(state);
    expect(seen(state, announced(30)).read).toEqual([]);
    expect(seen(state, announced(30)).read).toEqual([]);
    expect(seen(state, announced(31)).read).toEqual(["main"]);
  });

  it.each([
    ["the person opens another bot", { type: "select", id: "other" }],
    ["the person opens it again", { type: "select", id: "bot" }],
    ["the person switches conversation", { type: "switchTask", botId: "bot", threadId: "second" }],
    ["the person starts a new conversation", { type: "newTask", botId: "bot" }],
    ["the person writes in it", { type: "send", botId: "bot", text: "hello" }],
  ])("is read as before once %s", (_what, action) => {
    const state = open();
    mark(state);
    act(action, state);
    expect(seen(state, announced())).toEqual({ read: ["main"], unread: false, thread: false });
  });

  it("keeps a bot announced without its conversations unread", () => {
    const state = open();
    mark(state);
    const bot = { id: "bot", unread: true } as unknown as BotAnnouncement;
    expect(seen(state, bot)).toMatchObject({ read: [], unread: true });
    act({ type: "select", id: "bot" }, state);
    expect(seen(state, { id: "bot", unread: true } as unknown as BotAnnouncement)).toMatchObject({ read: ["main"], unread: false });
  });

  it("holds nothing for a bot marked while another chat is open: opening it reads it", () => {
    const state = open();
    mark(state, "other");
    const later = { ...state, selectedId: "other" } as AppState;
    expect(seen(later, announced(10, "other", "elsewhere"))).toEqual({ read: ["elsewhere"], unread: false, thread: false });
  });

  it("holds nothing while the chat is not what the person is looking at", () => {
    const state = { ...open(), activeView: "routines" } as unknown as AppState;
    mark(state);
    expect(seen(open(), announced()).read).toEqual(["main"]);
  });
});
