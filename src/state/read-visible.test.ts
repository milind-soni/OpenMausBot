import { describe, expect, it, vi } from "vitest";
import { holdMarkedUnread, markVisibleBotThreadsRead, markVisibleGroupThreadsRead, shownChatHeldUnread } from "./read-visible";
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

  it("stays unread through what the person does without leaving it", () => {
    const state = open();
    mark(state);
    act({ type: "toggleSidebar" }, state);
    act({ type: "markUnread", botId: "other" }, state);
    expect(seen(state, announced()).read).toEqual([]);
    expect(shownChatHeldUnread(state)).toBe(true);
    act({ type: "select", id: "bot" }, state);
  });

  it.each([
    ["Files", { activeView: "files" }],
    ["Routines", { activeView: "routines" }],
    ["a blank new conversation", { newChat: { session: 1, botId: "bot", held: [] } }],
  ])("is read as before once the person comes back from %s", (_where, away) => {
    const state = open();
    mark(state);
    act({ type: "showChat" }, { ...state, ...away } as unknown as AppState);
    expect(shownChatHeldUnread(state)).toBe(false);
    expect(seen(state, announced())).toEqual({ read: ["main"], unread: false, thread: false });
  });

  it("is held for the window getting focus back only until a newer message is in it", () => {
    const state = open();
    expect(shownChatHeldUnread(state)).toBe(false);
    mark(state);
    expect(shownChatHeldUnread(state)).toBe(true);
    expect(shownChatHeldUnread(open(11))).toBe(false);
    expect(shownChatHeldUnread({ ...state, activeView: "files" } as unknown as AppState)).toBe(false);
    act({ type: "select", id: "bot" }, state);
    expect(shownChatHeldUnread(state)).toBe(false);
  });

  describe("held by the server", () => {
    const heldBy = (updatedAt = 10) => ({ id: "bot", unread: true, tasks: [{ threadId: "main", unread: true, updatedAt, heldUnread: "m1" }] }) as unknown as BotAnnouncement;
    const reloadedPage = async (state: AppState) => {
      vi.resetModules();
      const page = await import("./read-visible");
      const reasons: string[] = [];
      const see = (bot: BotAnnouncement) => {
        page.markVisibleBotThreadsRead(state, bot, true, (_path, threadId, _updatedAt, reason) => reasons.push(`${threadId}:${reason}`));
        return { reasons: [...reasons], unread: bot.unread };
      };
      return { page, see };
    };
    const showing = (bot: BotAnnouncement) => ({ ...open(), bots: [{ id: "bot", threadId: "main", tasks: bot.tasks }] }) as unknown as AppState;

    it("survives a reloaded page and reaches another window that shows the conversation", async () => {
      const state = showing(heldBy());
      const { page, see } = await reloadedPage(state);
      expect(see(heldBy())).toEqual({ reasons: [], unread: true });
      expect(see(heldBy())).toEqual({ reasons: [], unread: true });
      expect(page.shownChatHeldUnread(state), "getting focus back does not read it").toBe(true);
    });

    it("is read once the person opens it again in that page, saying so to the server", async () => {
      const state = showing(heldBy());
      const { page, see } = await reloadedPage(state);
      page.holdMarkedUnread({ type: "select", id: "bot" } as Action, state);
      expect(page.shownChatHeldUnread(state)).toBe(false);
      expect(see(heldBy()).reasons).toEqual(["main:open"]);
    });

    it("ends only for the conversation the person opens, never for a marked one shown beside it", async () => {
      const both = () => ({ id: "bot", unread: true, tasks: [{ threadId: "main", unread: true, updatedAt: 10, heldUnread: "m1" },
        { threadId: "fork", unread: true, updatedAt: 10, heldUnread: "f1" }] }) as unknown as BotAnnouncement;
      const state = { ...showing(both()), forkPanel: { kind: "bot", ownerId: "bot", threadId: "fork" } } as unknown as AppState;
      const { page, see } = await reloadedPage(state);
      page.holdMarkedUnread({ type: "select", id: "bot" } as Action, state);
      expect(see(both())).toEqual({ reasons: ["main:open"], unread: true });
      page.holdMarkedUnread({ type: "switchTask", botId: "bot", threadId: "fork" } as Action, state);
      const mainRead = both();
      mainRead.tasks![0] = { threadId: "main", unread: false, updatedAt: 10 } as never;
      expect(see(mainRead).reasons).toEqual(["main:open", "fork:open"]);
    });

    it("is read as only seen once the server says a newer reply ended it", async () => {
      const after = { id: "bot", unread: true, tasks: [{ threadId: "main", unread: true, updatedAt: 11 }] } as unknown as BotAnnouncement;
      const state = showing(after);
      const { page, see } = await reloadedPage(state);
      expect(page.shownChatHeldUnread(state)).toBe(false);
      expect(see(after)).toEqual({ reasons: ["main:seen"], unread: false });
    });

    it("is held again when marked again after being opened", async () => {
      const state = showing(heldBy());
      const { page, see } = await reloadedPage(state);
      page.holdMarkedUnread({ type: "select", id: "bot" } as Action, state);
      page.holdMarkedUnread({ type: "markUnread", botId: "bot" } as Action, state);
      expect(see(heldBy()).reasons).toEqual([]);
      page.holdMarkedUnread({ type: "select", id: "bot" } as Action, state);
    });
  });
});
