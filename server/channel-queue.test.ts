import { describe, expect, it, vi } from "vitest";

import {
  _queuedChannelCount,
  cancelChannelMessage,
  drainChannelMessages,
  headChannelGroup,
  holdChannelQueue,
  queuedChannelMessage,
  queueChannelMessage,
  restoreChannelMessages,
  restoreHeldChannelQueue,
  resolveHeldReplyTarget,
  settleHeldChannelQueueHead,
  type ChannelQueueItem,
} from "./channel-queue.ts";
import { chatFollowups, saveChatFollowup } from "./message-db.ts";

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
  it("keeps readable citation prompts byte-for-byte through room queue and steer hold", () => {
    const prompt = '<!--omb-citation-v1:fixture-->\n> Quoted message:\n> multiline 🐭\n>   code\n\nComment:\nCheck it';
    const queued = queueChannelMessage("group-citation", "thread-citation", prompt);
    const held = holdChannelQueue("group-citation", "thread-citation", queued.id)!;
    expect(held.items[0].text).toBe(prompt);
    restoreHeldChannelQueue(held);
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

  it("keeps who sent the head of a held queue, so a room steer can still name them", () => {
    const head = queueChannelMessage("group-sender-held", "thread-sender-held", "steer me", { sender: { name: "Priya" } });
    const held = holdChannelQueue("group-sender-held", "thread-sender-held", head.id);
    expect(held?.items[0].sender).toEqual({ name: "Priya" });
    settleHeldChannelQueueHead(held!);
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

  it("lifts the whole queue atomically for a live steer, so a settle cannot drain it too", () => {
    const head = queueChannelMessage("group-c", "thread-c", "steer me");
    queueChannelMessage("group-c", "thread-c", "behind the head");

    expect(holdChannelQueue("group-c", "thread-c", "unknown")).toBeNull();
    expect(holdChannelQueue("group-other", "thread-c", head.id)).toBeNull();
    expect(_queuedChannelCount("thread-c")).toBe(2);

    const held = holdChannelQueue("group-c", "thread-c", head.id);
    expect(held?.items.map((item) => item.id)).toEqual([head.id, expect.any(String)]);
    expect(_queuedChannelCount("thread-c")).toBe(0);
    const run = vi.fn();
    drainChannelMessages(() => false, run);
    expect(run).not.toHaveBeenCalled();

    restoreHeldChannelQueue(held!);
    expect(_queuedChannelCount("thread-c")).toBe(2);
    // Leave the shared map clean for the tests that follow.
    for (const item of held!.items) cancelChannelMessage("group-c", item.id);
    expect(_queuedChannelCount("thread-c")).toBe(0);
  });

  it("refuses to lift the queue when the request names a later item, not the head", () => {
    const head = queueChannelMessage("group-f", "thread-f", "the head must stay");
    const later = queueChannelMessage("group-f", "thread-f", "named by the request");

    expect(holdChannelQueue("group-f", "thread-f", later.id)).toBeNull();
    expect(_queuedChannelCount("thread-f")).toBe(2);
    const run = vi.fn();
    drainChannelMessages(() => false, run);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      items: [
        expect.objectContaining({ id: head.id, text: "the head must stay" }),
        expect.objectContaining({ id: later.id, text: "named by the request" }),
      ],
    }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(_queuedChannelCount("thread-f")).toBe(0);
  });

  it("restores a refused steer behind words that queued while the hold was open", () => {
    const first = queueChannelMessage("group-d", "thread-d", "refused head");
    const held = holdChannelQueue("group-d", "thread-d", first.id)!;
    // The room kept accepting sends while the steer was in flight.
    const late = queueChannelMessage("group-d", "thread-d", "arrived during the hold", {
      sendId: "send_late_123456",
    });

    restoreHeldChannelQueue(held);
    const run = vi.fn();
    drainChannelMessages(() => false, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      items: [
        expect.objectContaining({ id: first.id }),
        expect.objectContaining({ id: late.id, sendId: "send_late_123456" }),
      ],
    }));
    expect(_queuedChannelCount("thread-d")).toBe(0);
  });

  it("restores the held queue when the head's reply target can no longer be resolved", () => {
    const head = queueChannelMessage("group-h", "thread-h", "reply to a vanished message", {
      replyToId: "msg_gone",
    });
    const held = holdChannelQueue("group-h", "thread-h", head.id)!;
    expect(_queuedChannelCount("thread-h")).toBe(0);

    expect(() =>
      resolveHeldReplyTarget(held, () => {
        throw new Error("the message being replied to is no longer available");
      }),
    ).toThrow("no longer available");
    expect(_queuedChannelCount("thread-h")).toBe(1);
    const run = vi.fn();
    drainChannelMessages(() => false, run);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ items: [expect.objectContaining({ id: head.id, replyToId: "msg_gone" })] }));
    cancelChannelMessage("group-h", head.id);
  });

  it("settles only the steered head and re-queues the tail for the room drain", () => {
    const head = queueChannelMessage("group-e", "thread-e", "folded into the running turn");
    // A different sender, so the tail is not part of the steered head group.
    const tail = queueChannelMessage("group-e", "thread-e", "still waits its own turn", { sender: { name: "Priya" } });
    const held = holdChannelQueue("group-e", "thread-e", head.id)!;

    settleHeldChannelQueueHead(held);
    const run = vi.fn();
    drainChannelMessages(() => false, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ items: [expect.objectContaining({ id: tail.id, text: "still waits its own turn" })] }));
    expect(_queuedChannelCount("thread-e")).toBe(0);
  });

  it("settles the steered reply burst durably and restores the tail before messages queued during the hold", () => {
    const head = queueChannelMessage("group-replies", "thread-replies", "first reply", { replyToId: "reply-a" });
    const second = queueChannelMessage("group-replies", "thread-replies", "second reply", { replyToId: "reply-b" });
    const plain = queueChannelMessage("group-replies", "thread-replies", "plain line");
    const tail = queueChannelMessage("group-replies", "thread-replies", "another person's turn", { sender: { name: "Priya" } });
    const held = holdChannelQueue("group-replies", "thread-replies", head.id)!;
    const late = queueChannelMessage("group-replies", "thread-replies", "arrived during the hold");

    const steeredIds = headChannelGroup(held.items).map(({ id }) => id);
    settleHeldChannelQueueHead(held);
    const pendingIds = chatFollowups("channel").filter((row) => row.threadId === "thread-replies").map((row) => row.id);
    const queuedBeforeRestart = _queuedChannelCount("thread-replies");
    restoreChannelMessages();
    const queuedAfterRestart = _queuedChannelCount("thread-replies");

    const run = vi.fn();
    drainChannelMessages((_groupId, threadId) => threadId !== "thread-replies", run);
    drainChannelMessages((_groupId, threadId) => threadId !== "thread-replies", run);
    const remaining = _queuedChannelCount("thread-replies");
    for (const queued of [head, second, plain, tail, late]) cancelChannelMessage("group-replies", queued.id);

    expect(steeredIds).toEqual([head.id, second.id, plain.id]);
    expect(pendingIds).toEqual([tail.id, late.id]);
    expect(queuedBeforeRestart).toBe(2);
    expect(queuedAfterRestart).toBe(2);
    expect(run.mock.calls.map(([input]) => input.items.map((queued: ChannelQueueItem) => queued.id))).toEqual([[tail.id], [late.id]]);
    expect(remaining).toBe(0);
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
