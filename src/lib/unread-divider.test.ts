import { describe, expect, it } from "vitest";
import { firstUnreadMessageId, threadOpensUnread, unreadMessageIds } from "./unread-divider";
import { initialState, reducer, type AppState, type Bot, type Group, type Message } from "@/state/store";

const line = (id: string, role: Message["role"], fields: Partial<Message> = {}): Message =>
  ({ id, role, kind: "text", text: id, at: Number(id.replace(/\D/g, "")) || 1, ...fields });

describe("firstUnreadMessageId", () => {
  it("is the first line after the person's newest one", () => {
    expect(firstUnreadMessageId([line("u1", "user"), line("b2", "bot"), line("u3", "user"), line("b4", "bot", { kind: "activity" }), line("b5", "bot")]))
      .toBe("b4");
  });

  it("does not take a line another bot delivered for the person's", () => {
    const peer = line("p3", "user", { peerAsk: { botId: "chief", name: "Chief" } });
    const legacyPeer = line("p4", "user", { text: "[Message from @Chief, another bot in this OpenMausBot workspace] hi" });
    expect(firstUnreadMessageId([line("u1", "user"), line("b2", "bot"), peer, legacyPeer, line("b5", "bot")])).toBe("b2");
  });

  it("starts after the last read message when the person read without replying", () => {
    const rows = [line("u1", "user"), line("a1", "bot"), line("a2", "bot")];
    expect(firstUnreadMessageId(rows, "a1")).toBe("a2");
    expect(firstUnreadMessageId(rows)).toBe("a1");
    expect(firstUnreadMessageId([line("b1", "bot"), line("b2", "bot")], "b1")).toBe("b2");
  });

  it("takes the person's own newer line over an older read cursor", () => {
    const rows = [line("b1", "bot"), line("u2", "user"), line("b3", "bot")];
    expect(firstUnreadMessageId(rows, "b1")).toBe("b3");
  });

  it("ignores a read cursor that is not among the messages", () => {
    const rows = [line("u1", "user"), line("a1", "bot"), line("a2", "bot")];
    expect(firstUnreadMessageId(rows, "other-branch")).toBe("a1");
    expect(firstUnreadMessageId(rows, "a2")).toBeNull();
  });

  it("is null when the person never wrote, or nothing came after them", () => {
    expect(firstUnreadMessageId([])).toBeNull();
    expect(firstUnreadMessageId([line("b1", "bot"), line("b2", "bot")])).toBeNull();
    expect(firstUnreadMessageId([line("b1", "bot"), line("u2", "user")])).toBeNull();
  });
});

describe("unreadMessageIds", () => {
  it("holds the divider's message and every later one, only when mounted", () => {
    const rows = [line("u1", "user"), line("b2", "bot"), line("b3", "bot")];
    expect([...unreadMessageIds(rows, "b2")!]).toEqual(["b2", "b3"]);
    expect(unreadMessageIds(rows, "gone")).toBeNull();
    expect(unreadMessageIds(rows, null)).toBeNull();
  });
});

describe("threadOpensUnread", () => {
  it("reads the open thread's flag, never a hidden routine run's", () => {
    const tasks = [{ threadId: "a", unread: true }, { threadId: "b", unread: false }, { threadId: "run", unread: true, routineRunId: "r1" }];
    expect(threadOpensUnread({ threadId: "a", unread: true, tasks })).toBe(true);
    expect(threadOpensUnread({ threadId: "b", unread: true, tasks })).toBe(false);
    expect(threadOpensUnread({ threadId: "run", unread: true, tasks })).toBe(false);
    expect(threadOpensUnread({ threadId: "a", unread: true })).toBe(true);
    expect(threadOpensUnread({ threadId: "a", unread: false, tasks: null })).toBe(false);
  });
});

describe("the divider in the store", () => {
  const transcript = [line("u1", "user"), line("b2", "bot"), line("b3", "bot")];
  const bot = (id: string, fields: Partial<Bot> = {}): Bot => ({
    id, threadId: `${id}-a`, name: id, title: "", description: "", color: "green", notifications: true, unread: false,
    messages: transcript, modelSelection: { instanceId: "test", model: "m" },
    tasks: [{ threadId: `${id}-a`, title: "A", createdAt: 1 }, { threadId: `${id}-b`, title: "B", createdAt: 1 }],
    ...fields,
  });
  const unreadTasks = (id: string, threadId: string, extra: object = {}) =>
    [{ threadId: `${id}-a`, title: "A", createdAt: 1 }, { threadId, title: "B", createdAt: 1, unread: true, ...extra }];
  const room: Group = { id: "room", threadId: "room-t", name: "Room", memberIds: [], defaultResponder: { kind: "everyone" }, bulletin: "", unread: true, createdAt: 1, messages: transcript };
  const base: AppState = {
    ...initialState,
    selectedId: "other",
    bots: [bot("other"), bot("pepper", { unread: true, tasks: [{ threadId: "pepper-a", title: "A", createdAt: 1, unread: true }] })],
    groups: [room],
  };

  it("is taken when an unread conversation opens, and the flag still clears", () => {
    const opened = reducer(base, { type: "select", id: "pepper" });
    expect(opened.unreadDivider).toEqual({ threadId: "pepper-a", messageId: "b2" });
    expect(opened.bots.find((b) => b.id === "pepper")!.tasks![0]!.unread).toBe(false);
    expect(reducer(base, { type: "select", id: "room" }).unreadDivider).toEqual({ threadId: "room-t", messageId: "b2" });
  });

  it("holds while the conversation stays open, and goes with another one", () => {
    const opened = reducer(base, { type: "select", id: "pepper" });
    const streamed = reducer(opened, { type: "messageAdded", threadId: "pepper-a", message: line("b9", "bot") });
    expect(streamed.unreadDivider).toEqual(opened.unreadDivider);
    expect(reducer(opened, { type: "select", id: "pepper" }).unreadDivider).toEqual(opened.unreadDivider);
    expect(reducer(opened, { type: "select", id: "other" }).unreadDivider).toBeNull();
  });

  it("is taken for a thread switched to, but not for a bot in the background", () => {
    const selected = { ...base, selectedId: "pepper", activeView: "chat" as const };
    const switched = reducer(selected, { type: "taskSwitched", bot: bot("pepper", { threadId: "pepper-b", tasks: unreadTasks("pepper", "pepper-b") }) });
    expect(switched.unreadDivider).toEqual({ threadId: "pepper-b", messageId: "b2" });
    expect(switched.bots.find((b) => b.id === "pepper")!.tasks!.find((task) => task.threadId === "pepper-b")!.unread).toBe(false);
    const background = reducer(switched, { type: "taskSwitched", bot: bot("other", { threadId: "other-b", tasks: unreadTasks("other", "other-b") }) });
    expect(background.unreadDivider).toEqual(switched.unreadDivider);
    expect(background.bots.find((b) => b.id === "other")!.tasks!.find((task) => task.threadId === "other-b")!.unread).toBe(true);
    const away = reducer({ ...selected, activeView: "routines" }, { type: "taskSwitched", bot: bot("pepper", { threadId: "pepper-b", tasks: unreadTasks("pepper", "pepper-b") }) });
    expect(away.bots.find((b) => b.id === "pepper")!.tasks!.find((task) => task.threadId === "pepper-b")!.unread).toBe(true);
  });

  it("never comes from a hidden routine run", () => {
    const selected = { ...base, selectedId: "pepper" };
    const run = reducer(selected, { type: "taskSwitched", bot: bot("pepper", { threadId: "pepper-b", tasks: unreadTasks("pepper", "pepper-b", { routineRunId: "r1" }) }) });
    expect(run.unreadDivider).toBeNull();
  });

  it("goes after the read cursor of the conversation that opens", () => {
    const read = { ...base, bots: [bot("other"), bot("pepper", { unread: true, tasks: [{ threadId: "pepper-a", title: "A", createdAt: 1, unread: true, lastReadMessageId: "b2" }] })],
      groups: [{ ...room, lastReadMessageId: "b2" }] };
    expect(reducer(read, { type: "select", id: "pepper" }).unreadDivider).toEqual({ threadId: "pepper-a", messageId: "b3" });
    expect(reducer(read, { type: "select", id: "room" }).unreadDivider).toEqual({ threadId: "room-t", messageId: "b3" });
  });

  it("waits above a short switch page until scrollback reaches the boundary", () => {
    const tail = [line("b4", "bot"), line("b5", "bot")];
    const short = { ...base, bots: [bot("other"), bot("pepper", { unread: true, hasMore: true, messages: tail,
      tasks: [{ threadId: "pepper-a", title: "A", createdAt: 1, unread: true, lastReadMessageId: "b1" }] })],
    groups: [{ ...room, hasMore: true, messages: tail, lastReadMessageId: "b1" }] };
    for (const [id, threadId] of [["pepper", "pepper-a"], ["room", "room-t"]] as const) {
      const opened = reducer(short, { type: "select", id });
      expect(opened.unreadDivider?.messageId ?? null).toBeNull();
      const partial = reducer(opened, { type: "olderMessages", threadId, generation: 0, messages: [line("b3", "bot")], hasMore: true });
      expect(partial.unreadDivider?.messageId ?? null).toBeNull();
      const reached = reducer(partial, { type: "olderMessages", threadId, generation: 0, messages: [line("b1", "bot"), line("b2", "bot")], hasMore: false });
      expect(reached.unreadDivider).toEqual({ threadId, messageId: "b2" });
    }
  });

  it("places a waiting divider when a reload or reselect brings the boundary in", () => {
    const full = ["b1", "b2", "b3", "b4", "b5"].map((id) => line(id, "bot"));
    const tasks = [{ threadId: "pepper-a", title: "A", createdAt: 1, lastReadMessageId: "b1" }];
    const short = { ...base, bots: [bot("other"), bot("pepper", { unread: true, hasMore: true, messages: full.slice(3), tasks: [{ ...tasks[0]!, unread: true }] })] };
    const opened = reducer(short, { type: "select", id: "pepper" });
    expect(opened.unreadDivider?.messageId ?? null).toBeNull();
    const read = bot("pepper", { messages: full, tasks });
    expect(reducer(opened, { type: "hydrate", bots: [bot("other"), read], groups: [], computerControl: {} }).unreadDivider).toEqual({ threadId: "pepper-a", messageId: "b2" });
    expect(reducer({ ...opened, bots: [bot("other"), read] }, { type: "select", id: "pepper" }).unreadDivider).toEqual({ threadId: "pepper-a", messageId: "b2" });
  });

  it("places a waiting room divider when a new room transcript brings the boundary in", () => {
    const tail = [line("b4", "bot"), line("b5", "bot")];
    const short = { ...base, groups: [{ ...room, hasMore: true, messages: tail, lastReadMessageId: "b1" }] };
    const opened = reducer(short, { type: "select", id: "room" });
    expect(opened.unreadDivider?.messageId ?? null).toBeNull();
    expect(reducer(opened, { type: "groupPatched", group: { id: "room", messages: transcript, hasMore: false } }).unreadDivider).toEqual({ threadId: "room-t", messageId: "b2" });
    expect(reducer(opened, { type: "groupPatched", group: { id: "room", name: "Renamed" } }).unreadDivider).toEqual(opened.unreadDivider);
  });

  it("leaves no divider alone when a snapshot has a conversation without a thread", () => {
    const loose = bot("loose", { threadId: undefined as unknown as string });
    expect(reducer(base, { type: "hydrate", bots: [bot("other"), loose], groups: [], computerControl: {} }).unreadDivider).toBeNull();
  });

  it("is dropped once done, only for its own conversation", () => {
    const opened = reducer(base, { type: "select", id: "pepper" });
    expect(reducer(opened, { type: "unreadDividerDone", threadId: "elsewhere" })).toBe(opened);
    expect(reducer(opened, { type: "unreadDividerDone", threadId: "pepper-a" }).unreadDivider).toBeNull();
  });
});
