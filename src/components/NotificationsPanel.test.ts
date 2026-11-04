import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState, StoreContext, type Bot } from "@/state/store";
import { ALL_BOTS, filterNotifications, notificationBots, notificationBotForAvatar, notificationThreadName, NotificationsPanel, postNotificationRead } from "./NotificationsPanel";

const state = {
  bots: [{ id: "b1", threadId: "t-main", tasks: [{ threadId: "t-main", title: "Notification Pane" }, { threadId: "t-2", title: "Hotpatches" }] }],
  groups: [{ threadId: "g-main", name: "Mantis-email & co.", tasks: [{ threadId: "g-task", title: "Skill rollout" }] }],
};

describe("a row in the bell", () => {
  const scout: Bot = { id: "scout", threadId: "main", name: "Scout", title: "", description: "", notifications: true, color: "green", unread: false, modelSelection: { instanceId: "fake", model: "m" }, messages: [],
    tasks: [{ threadId: "main", title: "Main", createdAt: 1 }, { threadId: "work", title: "@CoS · work", createdAt: 2 }] };
  const entry = (threadId: string) => ({ id: threadId, at: 1, read: true, kind: "done" as const, botId: "scout", botName: "Scout", threadId, title: "Scout finished", body: "Done" });
  function click(threadId: string) {
    const dispatch = vi.fn();
    const rows: ReactElement<{ onOpen: () => void }>[] = [];
    const walk = (node: ReactNode) => Children.forEach(node, (child) => {
      if (!isValidElement<{ children?: ReactNode; onOpen?: () => void }>(child)) return;
      if (child.props.onOpen) rows.push(child as ReactElement<{ onOpen: () => void }>);
      walk(child.props.children);
    });
    const state = { ...initialState, bots: [scout], notifications: [entry(threadId)] };
    function Capture() { walk(NotificationsPanel()); return null; }
    renderToStaticMarkup(createElement(StoreContext.Provider, { value: { state, dispatch } as never }, createElement(Capture)));
    rows[0]!.props.onOpen();
    return dispatch.mock.calls.map(([action]) => action);
  }

  it("lands on a thread another bot opened, and reveals its row in the sidebar", () => {
    const actions = click("work");
    expect(actions).toContainEqual({ type: "switchTask", botId: "scout", threadId: "work" });
    expect(actions).toContainEqual({ type: "revealThread", threadId: "work" });
  });

  it("says so when that thread is gone, never landing silently on another chat", () => {
    expect(click("deleted")).toContainEqual({ type: "notice", notice: { kind: "thread-gone", botName: "Scout" } });
  });
});

describe("notificationThreadName", () => {
  it("finds a bot task title", () => {
    expect(notificationThreadName({ botId: "b1", threadId: "t-2" }, state)).toBe("Hotpatches");
  });
  it("finds a room task title, else the room name", () => {
    expect(notificationThreadName({ botId: "b1", threadId: "g-task" }, state)).toBe("Skill rollout");
    expect(notificationThreadName({ botId: "b1", threadId: "g-main" }, state)).toBe("Mantis-email & co.");
  });
  it("returns null for an unknown thread", () => {
    expect(notificationThreadName({ botId: "b1", threadId: "gone" }, state)).toBeNull();
  });
});

describe("bot filter", () => {
  const rows = [
    { botId: "b2", botName: "Dev" },
    { botId: "b1", botName: "Claw1" },
    { botId: "b2", botName: "Dev" },
  ];
  it("lists each bot once, sorted by name", () => {
    expect(notificationBots(rows)).toEqual([{ id: "b1", name: "Claw1" }, { id: "b2", name: "Dev" }]);
  });
  it("filters to one bot, or returns everything for all", () => {
    expect(filterNotifications(rows, "b2")).toHaveLength(2);
    expect(filterNotifications(rows, ALL_BOTS)).toHaveLength(3);
    expect(filterNotifications(rows, "none")).toHaveLength(0);
  });
});

describe("notificationBotForAvatar", () => {
  const bots = [{ id: "a" }, { id: "b" }];
  it("finds the bot that sent the notification", () => {
    expect(notificationBotForAvatar({ botId: "b" }, bots)).toBe(bots[1]);
  });
  it("returns null for workspace events or deleted bots", () => {
    expect(notificationBotForAvatar({ botId: "gone" }, bots)).toBeNull();
  });
});

describe("postNotificationRead", () => {
  afterEach(() => vi.unstubAllGlobals());
  const reply = (ok: boolean, body: unknown = {}) => ({ ok, json: async () => body });

  it("does nothing more when the server accepts the request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(true));
    vi.stubGlobal("fetch", fetchMock);
    const dispatch = vi.fn();
    await postNotificationRead("/api/notifications/read-all", dispatch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("reloads the feed from the server after an HTTP error", async () => {
    const feed = [{ id: "n1" }];
    const fetchMock = vi.fn().mockResolvedValueOnce(reply(false)).mockResolvedValueOnce(reply(true, { notifications: feed }));
    vi.stubGlobal("fetch", fetchMock);
    const dispatch = vi.fn();
    await postNotificationRead("/api/notifications/n1/read", dispatch);
    expect(dispatch).toHaveBeenCalledWith({ type: "notificationsHydrated", notifications: feed });
  });

  it("reloads the feed after a network error, and stays quiet if that fails too", async () => {
    const feed = [{ id: "n1" }];
    const dispatch = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(reply(true, { notifications: feed })));
    await postNotificationRead("/api/notifications/n1/read", dispatch);
    expect(dispatch).toHaveBeenCalledWith({ type: "notificationsHydrated", notifications: feed });
    dispatch.mockClear();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    await expect(postNotificationRead("/api/notifications/n1/read", dispatch)).resolves.toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
