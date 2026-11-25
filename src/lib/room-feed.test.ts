import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppState, Group } from "@/state/store";
import { markVisibleGroupThreadsRead } from "@/state/read-visible";
import { openThread, visibleNotificationThread } from "@/state/thread-navigation";
import { feedPreview, feedThreadAction, openRoomThreadThen, openThreadBeside, roomFeedShows } from "./room-feed";
import { roomThreadAttention } from "./room-threads";

const on = { features: { roomFeed: true } } as AppState["config"];
const off = { features: { roomFeed: false } } as AppState["config"];
const room = (extra: Partial<Group> = {}) => ({ id: "room", name: "Launch", threadId: "current", memberIds: ["kiwi"], messages: [{ id: "m" }],
  tasks: [{ threadId: "current", title: "", createdAt: 1, unread: true }, { threadId: "other", title: "", createdAt: 2, unread: true }], ...extra } as unknown as Group);
const kiwi = { id: "kiwi", name: "Kiwi", threadId: "kiwi-main", tasks: [{ threadId: "kiwi-main" }, { threadId: "kiwi-side" }] };
const state = (config: AppState["config"], extra: Partial<AppState> = {}) =>
  ({ config, groups: [room()], bots: [kiwi], activeView: "chat", selectedId: "room", forkPanel: null, ...extra } as unknown as AppState);
const narrow = () => vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });

afterEach(() => vi.unstubAllGlobals());

describe("the room feed switch", () => {
  it("shows a room's feed only with the switch on, never for a bot-to-bot room, and not on a phone", () => {
    expect(roomFeedShows(on, room())).toBe(true);
    expect(roomFeedShows(off, room())).toBe(false);
    expect(roomFeedShows(undefined, room())).toBe(false);
    expect(roomFeedShows(on, room({ dm: true }))).toBe(false);
    expect(roomFeedShows(on, room(), false)).toBe(false);
  });

  it("opens a room's thread beside the feed instead of moving the room's current thread, and leaves it alone with the switch off", () => {
    expect(feedThreadAction({ type: "switchGroupTask", groupId: "room", threadId: "other" }, state(on)))
      .toEqual({ type: "openForkPanel", kind: "group", ownerId: "room", threadId: "other" });
    const switching = { type: "switchGroupTask" as const, groupId: "room", threadId: "other" };
    expect(feedThreadAction(switching, state(off))).toBe(switching);
    const fresh = { type: "newGroupTask" as const, groupId: "room" };
    expect(feedThreadAction(fresh, state(off))).toBe(fresh);
  });

  it("opens a notification's room thread beside the feed, the room's current one too", () => {
    const sent: unknown[] = [];
    openThread((action) => sent.push(action), { botId: "kiwi", threadId: "current" }, state(on), true);
    expect(sent).toEqual([{ type: "select", id: "room" }, { type: "openForkPanel", kind: "group", ownerId: "room", threadId: "current" }, { type: "revealThread", threadId: "current" }]);
    sent.length = 0;
    openThread((action) => sent.push(action), { botId: "kiwi", threadId: "other" }, state(off), true);
    expect(sent).toContainEqual({ type: "switchGroupTask", groupId: "room", threadId: "other" });
  });
});

describe("an Inbox line with the room feed on", () => {
  it("opens a room's thread or a bot's beside the chat", () => {
    const dispatch = vi.fn();
    expect(openThreadBeside(dispatch, "other", state(on, { selectedId: "kiwi" }))).toBe(true);
    expect(dispatch).toHaveBeenLastCalledWith({ type: "openForkPanel", kind: "group", ownerId: "room", threadId: "other" });
    expect(openThreadBeside(dispatch, "kiwi-side", state(on))).toBe(true);
    expect(dispatch).toHaveBeenLastCalledWith({ type: "openForkPanel", kind: "bot", ownerId: "kiwi", threadId: "kiwi-side" });
  });

  it("goes the usual way with the switch off, on a phone, for an unknown thread, or for the chat already on screen", () => {
    const dispatch = vi.fn();
    expect(openThreadBeside(dispatch, "other", state(off))).toBe(false);
    expect(openThreadBeside(dispatch, "gone", state(on))).toBe(false);
    expect(openThreadBeside(dispatch, "kiwi-main", state(on, { selectedId: "kiwi" }))).toBe(false);
    narrow();
    expect(openThreadBeside(dispatch, "other", state(on))).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("what the feed counts as read and on screen", () => {
  it("never reads the room's current thread for the feed, and reads the thread open beside it", () => {
    const posted: string[] = [];
    const post = (_path: string, threadId: string) => { posted.push(threadId); };
    markVisibleGroupThreadsRead(state(on), room(), true, post);
    expect(posted).toEqual([]);
    markVisibleGroupThreadsRead(state(on, { forkPanel: { kind: "group", ownerId: "room", threadId: "other" } as AppState["forkPanel"] }), room(), true, post);
    expect(posted).toEqual(["other"]);
    posted.length = 0;
    markVisibleGroupThreadsRead(state(off), room(), true, post);
    expect(posted).toEqual(["current"]);
  });

  it("reads a thread opened beside another chat", () => {
    const posted: string[] = [];
    markVisibleGroupThreadsRead(state(on, { selectedId: "kiwi", forkPanel: { kind: "group", ownerId: "room", threadId: "other" } as AppState["forkPanel"] }),
      room(), true, (_path, threadId) => { posted.push(threadId); });
    expect(posted).toEqual(["other"]);
  });

  it("lets a notification through for the feed's room, and holds one for the thread beside it", () => {
    expect(visibleNotificationThread(state(on), "current")).toBeNull();
    expect(visibleNotificationThread(state(off), "current")).toBe("current");
    expect(visibleNotificationThread(state(on, { selectedId: "kiwi", forkPanel: { kind: "group", ownerId: "room", threadId: "other" } as AppState["forkPanel"] }), "other")).toBe("other");
  });
});

describe("a feed room's sidebar line", () => {
  it("is the title of the thread that moved last, never an empty or archived one", () => {
    const tasks = [
      { threadId: "a", title: "Launch checklist", createdAt: 1, lastThreadOrderAt: 5 },
      { threadId: "b", title: "Old idea", createdAt: 2, lastThreadOrderAt: 9, archivedAt: 10 },
      { threadId: "c", title: "New task", createdAt: 3 },
      { threadId: "d", title: "Logo files", createdAt: 4, lastThreadOrderAt: 7 },
    ];
    expect(feedPreview({ tasks })).toBe("Logo files");
    expect(feedPreview({ tasks: [tasks[2]!] })).toBeUndefined();
  });
});

describe("a room's run opened from the calendar", () => {
  it("shows the room first and keeps the thread open beside the feed, and keeps today's order with the switch off", () => {
    const sent: unknown[] = [];
    const showRoom = (id: string) => sent.push({ type: "select", id });
    openRoomThreadThen((action) => sent.push(action), state(on), "room", "other", showRoom);
    expect(sent).toEqual([{ type: "select", id: "room" }, { type: "openForkPanel", kind: "group", ownerId: "room", threadId: "other" }]);
    sent.length = 0;
    openRoomThreadThen((action) => sent.push(action), state(off), "room", "other", showRoom);
    expect(sent).toEqual([{ type: "switchGroupTask", groupId: "room", threadId: "other" }, { type: "select", id: "room" }]);
  });
});

describe("a room thread's mark", () => {
  it("waits on the person when the thread does or the bot speaking in it does, and falls back to the room's unread for its current thread", () => {
    const busy = room({ tasks: [{ threadId: "current", title: "", createdAt: 1, busyBotId: "kiwi", working: true }, { threadId: "other", title: "", createdAt: 2, activity: "waiting-on-you" }], unread: true });
    expect(roomThreadAttention(busy, busy.tasks![0]!, [{ id: "kiwi", activity: "waiting-on-you" }])).toEqual({ waiting: true, unread: true });
    expect(roomThreadAttention(busy, busy.tasks![0]!, [{ id: "kiwi", activity: "working" }])).toEqual({ waiting: false, unread: true });
    expect(roomThreadAttention(busy, busy.tasks![1]!, [])).toEqual({ waiting: true, unread: false });
    expect(roomThreadAttention(busy, { ...busy.tasks![1]!, activity: undefined, unread: true }, [])).toEqual({ waiting: false, unread: true });
  });
});
