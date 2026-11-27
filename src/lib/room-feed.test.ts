import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppState, Group } from "@/state/store";
import { markVisibleGroupThreadsRead } from "@/state/read-visible";
import { openThread, visibleNotificationThread } from "@/state/thread-navigation";
import { feedPreview, feedThreadAction, openRoomThreadThen, openThreadBeside, catchUpOldMarks, roomFeedShows, staleUnreadThreads, takeFeedComposerWanted } from "./room-feed";
import { roomThreadAttention } from "./room-threads";

const on = { features: { roomFeed: true, roomFeedSince: 1 } } as AppState["config"];
/** A 0.1.181 home reports its old switch, off unless set, and no stamp. */
const home181 = { features: { roomFeed: false } } as AppState["config"];
const home181OptedIn = { features: { roomFeed: true } } as AppState["config"];
/** A home older than 0.1.181 reports nothing about the feed and has none of its routes. */
const off = { features: {} } as AppState["config"];
const room = (extra: Partial<Group> = {}) => ({ id: "room", name: "Launch", threadId: "current", memberIds: ["kiwi"], messages: [{ id: "m" }],
  tasks: [{ threadId: "current", title: "", createdAt: 1, unread: true }, { threadId: "other", title: "", createdAt: 2, unread: true }], ...extra } as unknown as Group);
const kiwi = { id: "kiwi", name: "Kiwi", threadId: "kiwi-main", tasks: [{ threadId: "kiwi-main" }, { threadId: "kiwi-side" }] };
const state = (config: AppState["config"], extra: Partial<AppState> = {}) =>
  ({ config, groups: [room()], bots: [kiwi], activeView: "chat", selectedId: "room", forkPanel: null, ...extra } as unknown as AppState);
const narrow = () => vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });

afterEach(() => vi.unstubAllGlobals());

describe("the room feed", () => {
  it("shows a room's feed wherever the server has it, never for a bot-to-bot room, and not on a phone", () => {
    expect(roomFeedShows(on, room())).toBe(true);
    expect(roomFeedShows(home181, room())).toBe(false);
    expect(roomFeedShows(home181OptedIn, room())).toBe(true);
    expect(roomFeedShows(off, room())).toBe(false);
    expect(roomFeedShows(undefined, room())).toBe(false);
    expect(roomFeedShows(on, room({ dm: true }))).toBe(false);
    expect(roomFeedShows(on, room(), false)).toBe(false);
  });

  it("opens a room's thread beside the feed instead of moving the room's current thread, and leaves it alone on an older server", () => {
    expect(feedThreadAction({ type: "switchGroupTask", groupId: "room", threadId: "other" }, state(on)))
      .toEqual({ type: "openForkPanel", kind: "group", ownerId: "room", threadId: "other" });
    const switching = { type: "switchGroupTask" as const, groupId: "room", threadId: "other" };
    expect(feedThreadAction(switching, state(off))).toBe(switching);
    const fresh = { type: "newGroupTask" as const, groupId: "room" };
    expect(feedThreadAction(fresh, state(off))).toBe(fresh);
  });

  it("a room's \"+\" puts the cursor in its feed composer, showing the room first when it is not on screen", () => {
    const fresh = { type: "newGroupTask" as const, groupId: "room" };
    expect(feedThreadAction(fresh, state(on))).toEqual({ type: "select", id: "room" });
    expect(takeFeedComposerWanted("other-room")).toBe(false);
    expect(takeFeedComposerWanted("room")).toBe(true);
    expect(takeFeedComposerWanted("room")).toBe(false);
    const box = { focus: vi.fn() };
    const feed = { dataset: { roomFeed: "room" }, querySelector: (selector: string) => (selector.includes("data-room-feed-composer") ? box : null) };
    vi.stubGlobal("document", { querySelectorAll: () => [{ dataset: { roomFeed: "elsewhere" }, querySelector: () => null }, feed] });
    expect(feedThreadAction(fresh, state(on))).toBeNull();
    expect(box.focus).toHaveBeenCalledTimes(1);
    expect(takeFeedComposerWanted("room")).toBe(false);
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

describe("an Inbox line where the server has the room feed", () => {
  it("opens a room's thread with its feed, showing the room first when another chat is on screen", () => {
    const dispatch = vi.fn();
    expect(openThreadBeside(dispatch, "other", state(on, { selectedId: "kiwi" }))).toBe(true);
    expect(dispatch.mock.calls).toEqual([[{ type: "select", id: "room" }], [{ type: "openForkPanel", kind: "group", ownerId: "room", threadId: "other" }]]);
    dispatch.mockClear();
    expect(openThreadBeside(dispatch, "other", state(on))).toBe(true);
    expect(dispatch.mock.calls).toEqual([[{ type: "openForkPanel", kind: "group", ownerId: "room", threadId: "other" }]]);
  });

  it("leaves a bot's thread to the chat, as before, and goes the usual way on an older server, on a phone or for an unknown thread", () => {
    const dispatch = vi.fn();
    expect(openThreadBeside(dispatch, "kiwi-side", state(on))).toBe(false);
    expect(openThreadBeside(dispatch, "kiwi-main", state(on, { selectedId: "kiwi" }))).toBe(false);
    expect(openThreadBeside(dispatch, "other", state(off))).toBe(false);
    expect(openThreadBeside(dispatch, "gone", state(on))).toBe(false);
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
  it("shows the room first and keeps the thread open beside the feed, and keeps the old order on an older server", () => {
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

describe("unread marks from before the feed", () => {
  const tasks = [
    { threadId: "old-unread", title: "", createdAt: 1, updatedAt: 50, unread: true },
    { threadId: "old-read", title: "", createdAt: 2, updatedAt: 60, unread: false },
    { threadId: "new-unread", title: "", createdAt: 3, updatedAt: 150, unread: true },
    { threadId: "no-stamp", title: "", createdAt: 40, unread: true },
  ];

  it("are the unread threads whose last line came before this place had the feed; later ones stay", () => {
    expect(staleUnreadThreads({ tasks }, 100)).toEqual(["old-unread", "no-stamp"]);
    expect(staleUnreadThreads({ tasks }, undefined)).toEqual([]);
  });

  it("are read in one request per room, and the room counts as done only once that read succeeded", async () => {
    const saved = new Map<string, string>();
    const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); } };
    const calls: unknown[] = [];
    let fail = true;
    const request = (async (path: string, init?: RequestInit) => {
      calls.push([path, init?.body]);
      if (fail) throw new Error("offline");
      return { group: { id: "room", unread: false } };
    }) as never;
    const patched: unknown[] = [];
    const room = { id: "room", tasks };
    expect(await catchUpOldMarks(room, 100, (group) => patched.push(group), { request, storage })).toBe(false);
    expect(saved.get("omb-room-feed-old-marks-read")).toBeUndefined();
    fail = false;
    expect(await catchUpOldMarks(room, 100, (group) => patched.push(group), { request, storage })).toBe(true);
    expect(calls).toEqual([0, 1].map(() => ["/api/groups/room/read", JSON.stringify({ threadIds: ["old-unread", "no-stamp"] })]));
    expect(patched).toEqual([{ id: "room", unread: false }]);
    expect(JSON.parse(saved.get("omb-room-feed-old-marks-read")!)).toEqual(["room"]);
    // Done: a thread marked unread on purpose later keeps its mark.
    expect(await catchUpOldMarks(room, 100, () => {}, { request, storage })).toBe(false);
    expect(calls).toHaveLength(2);
    expect(await catchUpOldMarks({ id: "quiet", tasks: [] }, 100, () => {}, { request, storage })).toBe(true);
    expect(calls).toHaveLength(2);
  });
});
