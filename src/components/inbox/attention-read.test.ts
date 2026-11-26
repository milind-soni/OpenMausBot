// A finished conversation stays in the active list until it is
// read, then leaves for the finished list instead of showing in both. Reading means either opening the conversation or
// reading the news line that stands for it.
import { describe, expect, it } from "vitest";
import type { AppState } from "@/state/store";
import { inboxAttentionEntries, inboxOpenThread, readNewsThreads, unreadConversations } from "./InboxActive";

const bot = (id: string, tasks: Array<Record<string, unknown>>) =>
  ({ id, name: id, hidden: false, threadId: `${id}-main`, tasks } as unknown as AppState["bots"][number]);
const state = (bots: AppState["bots"]) =>
  ({ bots, pendingQueued: {}, groups: [] } as unknown as Pick<AppState, "bots" | "pendingQueued" | "groups">);
const view = (rows: Array<Record<string, unknown>>) =>
  ({ botId: null, threadId: null, rows, anchor: null } as never);

const bots = [bot("eli", [
  { threadId: "eli-a", title: "Finished but unread", createdAt: 1, updatedAt: 2, unread: true },
  { threadId: "eli-b", title: "Finished and read", createdAt: 1, updatedAt: 3, unread: false },
])];
const line = (unread: boolean) => [{ id: "l1", tab: "info", origin: { threadId: "eli-a" }, unread }];

describe("inboxAttentionEntries", () => {
  it("keeps a finished conversation in the active list while its news is unread, counted once with that line", () => {
    expect(inboxAttentionEntries(state(bots), view(line(true))).map((entry) => entry.task.threadId)).toEqual(["eli-a"]);
    expect(unreadConversations(inboxAttentionEntries(state(bots), view(line(true))), view(line(true)))).toBe(0);
  });

  it("counts an unread conversation whose news has no line of its own in the list", () => {
    const quiet = [bot("eli", [{ threadId: "eli-c", title: "News without a line", createdAt: 1, updatedAt: 4, unread: true }])];
    expect(unreadConversations(inboxAttentionEntries(state(quiet), view([])), view([]))).toBe(1);
  });

  it("moves it off the active list once its news line is read, even before the chat is opened", () => {
    expect(inboxAttentionEntries(state(bots), view(line(false)))).toEqual([]);
  });

  it("counts a conversation read when every one of its news lines is read", () => {
    expect([...readNewsThreads(view(line(false)))]).toEqual(["eli-a"]);
    expect([...readNewsThreads(view(line(true)))]).toEqual([]);
  });

  it("still counts it read once its read result has moved to the Done line, so Mark all as read empties the active list", () => {
    const moved = [{ id: "l1", kind: "result", tab: "done", origin: { threadId: "eli-a" }, unread: false }];
    expect([...readNewsThreads(view(moved))]).toEqual(["eli-a"]);
    expect(inboxAttentionEntries(state(bots), view(moved))).toEqual([]);
    expect(unreadConversations(inboxAttentionEntries(state(bots), view(moved)), view(moved))).toBe(0);
    // A line the person only marked done is no reading of the conversation.
    expect([...readNewsThreads(view([{ id: "l2", kind: "message", tab: "done", origin: { threadId: "eli-a" }, unread: false }]))]).toEqual([]);
  });
});

const open = (selectedId: string, activeView = "chat") =>
  ({ bots, pendingQueued: {}, groups: [{ id: "room", threadId: "room-thread" }], activeView, selectedId } as unknown as
    Pick<AppState, "activeView" | "selectedId" | "bots" | "groups">);

describe("inboxOpenThread", () => {
  it("names the open bot thread or room thread so both lists can mark that row", () => {
    expect(inboxOpenThread(open("eli"))).toEqual({ kind: "bot", botId: "eli", threadId: "eli-main" });
    expect(inboxOpenThread(open("room"))).toEqual({ kind: "group", groupId: "room", threadId: "room-thread" });
  });

  it("names nothing while the chat is not what the window shows", () => {
    expect(inboxOpenThread(open("eli", "routines"))).toBeUndefined();
    expect(inboxOpenThread(open("nobody"))).toBeUndefined();
  });
});
