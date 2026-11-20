import { describe, expect, it, vi } from "vitest";

import {
  _queuedChannelCount,
  cancelChannelMessage,
  drainChannelMessages,
  headChannelGroup,
  queuedChannelMessage,
  queueChannelMessage,
  restoreChannelMessages,
  type ChannelQueueItem,
} from "./channel-queue.ts";
import { saveChatFollowup } from "./message-db.ts";

describe("channel queue batches", () => {
  const item = (id: string, options: Partial<ChannelQueueItem> = {}): ChannelQueueItem => ({
    id, text: id, mode: "chat", queuedAt: 1_000, ...options,
  });

  it.each([
    ["quoted then unquoted", "reply-a", undefined, 1],
    ["unquoted then quoted", undefined, "reply-a", 1],
    ["different replies", "reply-a", "reply-b", 1],
    ["the same reply", "reply-a", "reply-a", 2],
    ["both unquoted", undefined, undefined, 2],
  ] as const)("drains %s messages by their reply target", (name, firstReply, secondReply, count) => {
    const groupId = `group-drain-${name}`;
    const threadId = `thread-drain-${name}`;
    const first = queueChannelMessage(groupId, threadId, "first", { replyToId: firstReply });
    const second = queueChannelMessage(groupId, threadId, "second", { replyToId: secondReply });
    const run = vi.fn();
    try {
      drainChannelMessages((_groupId, candidate) => candidate !== threadId, run);
      expect(run).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        items: [first, second].slice(0, count).map(({ id }) => expect.objectContaining({ id })),
      }));
    } finally {
      cancelChannelMessage(groupId, first.id);
      cancelChannelMessage(groupId, second.id);
    }
  });

  it.each([
    ["quoted then unquoted", "reply-a", undefined],
    ["unquoted then quoted", undefined, "reply-a"],
    ["different replies", "reply-a", "reply-b"],
    ["the same reply", "reply-a", "reply-a"],
    ["both unquoted", undefined, undefined],
  ] as const)("steers %s messages in the same person's burst", (_name, firstReply, secondReply) => {
    const first = item("first", { replyToId: firstReply });
    const second = item("second", { replyToId: secondReply, queuedAt: 1_001 });
    expect(headChannelGroup([first, second])).toEqual([first, second]);
  });

  it.each([
    ["API", { via: "api" }],
    ["goal", { mode: "goal" }],
    ["pointed", { pointed: { refs: [], blocks: { atlas: "picked page" } } }],
  ] satisfies Array<[string, Partial<ChannelQueueItem>]>)("keeps %s sends separate even with the same reply target", (_name, options) => {
    const first = item("first", { replyToId: "reply-a", ...options });
    const second = item("second", { replyToId: "reply-a", ...options });
    expect(headChannelGroup([first, second])).toEqual([first]);
  });

  it("keeps different people separate even with the same reply target", () => {
    const first = item("first", { replyToId: "reply-a", sender: { id: "priya", name: "Priya" } });
    const second = item("second", { replyToId: "reply-a", sender: { id: "alex", name: "Alex" } });
    expect(headChannelGroup([first, second])).toEqual([first]);
  });

  it("still coalesces one person's replies after their display name changes", () => {
    const first = item("first", { replyToId: "reply-a", sender: { id: "priya", name: "Priya" } });
    const second = item("second", { replyToId: "reply-a", sender: { id: "priya", name: "Priya Shah" } });
    expect(headChannelGroup([first, second])).toEqual([first, second]);
  });
});

describe("channel queue", () => {
  it("keeps readable citation prompts byte-for-byte through the room queue", () => {
    const prompt = '<!--omb-citation-v1:fixture-->\n> Quoted message:\n> multiline 🐭\n>   code\n\nComment:\nCheck it';
    queueChannelMessage("group-citation", "thread-citation", prompt);
    const run = vi.fn();
    drainChannelMessages(() => false, run);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      items: [expect.objectContaining({ text: prompt })],
    }));
  });

  it("keeps messages off the running channel and drains one follow-up at a time", () => {
    let working = true;
    const run = vi.fn(() => {
      working = true;
    });
    const first = queueChannelMessage("group-a", "thread-a", "first follow-up", {
      sendId: "send_first_123456",
    });
    queueChannelMessage("group-a", "thread-a", "second follow-up", {
      sendId: "send_second_123456",
      mode: "goal",
    });

    drainChannelMessages(() => working, run);
    expect(run).not.toHaveBeenCalled();
    expect(_queuedChannelCount("thread-a")).toBe(2);
    expect(queuedChannelMessage("group-a", "thread-a", "send_first_123456")?.id).toBe(first.id);

    working = false;
    drainChannelMessages(() => working, run);
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({
      groupId: "group-a",
      threadId: "thread-a",
      items: [expect.objectContaining({ text: "first follow-up", mode: "chat" })],
    }));
    expect(_queuedChannelCount("thread-a")).toBe(1);

    working = false;
    drainChannelMessages(() => working, run);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({
      items: [expect.objectContaining({ text: "second follow-up", mode: "goal" })],
    }));
    expect(_queuedChannelCount("thread-a")).toBe(0);
  });

  it("restores a visible follow-up and drains it with the original message id", () => {
    const row = { id: "visible-room-line", role: "user", kind: "text", text: "follow-up", at: Date.now() } as const;
    const queued = queueChannelMessage("group-visible", "thread-visible", row.text, {
      record: (followup) => {
        saveChatFollowup(followup, row);
        return row;
      },
    });
    restoreChannelMessages();

    const run = vi.fn();
    drainChannelMessages((_groupId, threadId) => threadId !== "thread-visible", run);
    expect(run).toHaveBeenCalledExactlyOnceWith({
      groupId: "group-visible", threadId: "thread-visible",
      items: [expect.objectContaining({ id: queued.id, rowId: row.id })],
    });
  });

  it("hands the drain who sent a queued message, through a restart too", () => {
    queueChannelMessage("group-sender", "thread-sender", "from the paired person", { sender: { name: "Priya" } });
    queueChannelMessage("group-sender", "thread-sender", "from the owner");
    restoreChannelMessages(); // a restart reads the name back from the durable row

    const run = vi.fn();
    drainChannelMessages(() => false, run);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "thread-sender",
      items: [expect.objectContaining({ text: "from the paired person", sender: { name: "Priya" } })],
    }));
    drainChannelMessages(() => false, run);
    const owner = run.mock.calls.map(([input]) => input.items[0]).find((item) => item.text === "from the owner");
    expect(owner).toBeDefined();
    expect(owner.sender).toBeUndefined();
  });

  it("still loads and drains a durable row written before senders were kept", () => {
    saveChatFollowup({
      id: "legacy-channel-followup-without-sender", kind: "channel", ownerId: "group-legacy", threadId: "thread-legacy",
      payload: { text: "queued by an older build", mode: "chat" },
    });
    expect(() => restoreChannelMessages()).not.toThrow();
    const run = vi.fn();
    drainChannelMessages(() => false, run);
    const legacy = run.mock.calls.map(([input]) => input).find((input) => input.threadId === "thread-legacy")?.items[0];
    expect(legacy).toMatchObject({ id: "legacy-channel-followup-without-sender", text: "queued by an older build", mode: "chat" });
    expect(legacy.sender).toBeUndefined();
  });

  it("cancels only the requested channel message", () => {
    const keep = queueChannelMessage("group-b", "thread-b", "keep");
    const drop = queueChannelMessage("group-b", "thread-b", "drop");

    expect(cancelChannelMessage("group-b", drop.id)).toBe(true);
    expect(cancelChannelMessage("group-b", drop.id)).toBe(false);
    expect(_queuedChannelCount("thread-b")).toBe(1);

    const run = vi.fn();
    drainChannelMessages(() => false, run);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ items: [expect.objectContaining({ id: keep.id, text: "keep" })] }));
  });

  it("drains an idle thread queue while another thread in the same group is working", () => {
    const item1 = queueChannelMessage("group-multi", "thread-busy", "waits for busy thread to settle");
    const item2 = queueChannelMessage("group-multi", "thread-idle", "runs immediately in idle thread");

    const run = vi.fn();
    drainChannelMessages((_groupId, threadId) => threadId === "thread-busy", run);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thread-idle", items: [expect.objectContaining({ id: item2.id })] }));
    expect(_queuedChannelCount("thread-busy")).toBe(1);
    expect(_queuedChannelCount("thread-idle")).toBe(0);

    cancelChannelMessage("group-multi", item1.id);
  });
});
