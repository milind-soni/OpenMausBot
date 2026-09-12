import { afterEach, describe, expect, it, vi } from "vitest";

import * as journal from "./message-db.ts";
import { cancelChannelMessage, drainChannelMessages, queuedChannelMessage, queueChannelMessage, restoreChannelMessages } from "./channel-queue.ts";
import { cancelSteeredMessage, drainSteeredMessages, queuedSteerSnapshot, queueSteeredMessage, restoreSteeredMessages, type SteerStore } from "./steer-queue.ts";
import type { BotRecord, Message } from "./store.ts";

afterEach(() => {
  vi.restoreAllMocks();
  journal.settleChatFollowups(journal.chatFollowups().map((row) => row.id), null);
  restoreSteeredMessages();
  restoreChannelMessages();
});

function storeFor(botId: string, threadId: string): SteerStore & { messages: Message[] } {
  const messages: Message[] = [];
  return {
    messages,
    bot: (id) => id === botId ? { id, threadId, busy: false } as BotRecord : null,
    appendMessage: (_thread, message) => {
      const saved = { ...message, id: `message-${messages.length}`, at: Date.now() };
      messages.push(saved);
      return saved;
    },
    patchMessage: () => null,
  };
}

describe("durable accepted follow-ups", () => {
  it("restores bot order, receipt, attachments, reply context and unattended provenance", async () => {
    const text = 'inspect this\n\n<attached-image path="/fixture/picture.png" name="picture.png" />';
    const first = queueSteeredMessage("bot", "thread", text, {
      prompt: `Reply context\n${text}`, replyToId: "reply", sendId: "first", reason: "capacity", unattended: true,
    });
    const second = queueSteeredMessage("bot", "thread", "then summarize", { sendId: "second" });
    const cancelled = queueSteeredMessage("bot", "thread", "never run", { sendId: "cancelled" });
    expect(cancelSteeredMessage("bot", cancelled.id)).toBe(true);
    journal.closeMessageDb();
    restoreSteeredMessages();
    expect(queuedSteerSnapshot(() => true)).toEqual({ thread: [
      { queueId: first.id, text, reason: "capacity" },
      { queueId: second.id, text: "then summarize" },
    ] });
    const store = storeFor("bot", "thread");
    const run = vi.fn(() => {
      expect(journal.chatFollowups().filter((row) => row.status === "dispatching").map((row) => row.id))
        .toEqual([first.id, second.id]);
    });
    drainSteeredMessages(store, run);
    expect(run.mock.calls[0]).toEqual([
      "bot", "thread", `Reply context\n${text}\n\nthen summarize`, store.messages[1],
      ["message-0", "message-1"], true,
    ]);
    expect(store.messages).toEqual([
      expect.objectContaining({ text, replyToId: "reply", sendId: "first", queueId: first.id }),
      expect.objectContaining({ text: "then summarize", sendId: "second", queueId: second.id }),
    ]);
    await Promise.resolve();
    expect(journal.chatFollowups().map((row) => row.id)).toEqual([cancelled.id]);
    expect(journal.cancelledChatFollowup("bot", "bot", "thread", "cancelled")).toBe(true);
    expect(journal.cancelledChatFollowup("bot", "other", "thread", "cancelled")).toBe(false);
    expect(journal.chatFollowups()[0].payload).toEqual({ text: "" });
  });

  it("restores channel target, mode and API provenance without reviving cancelled messages", async () => {
    const first = queueChannelMessage("group", "old-thread", "continue goal", {
      mode: "goal", via: "api", replyToId: "reply", sendId: "first",
    });
    const second = queueChannelMessage("group", "old-thread", "next", { sendId: "second" });
    const cancelled = queueChannelMessage("group", "old-thread", "drop", { sendId: "cancelled" });
    expect(cancelChannelMessage("group", cancelled.id)).toBe(true);
    journal.closeMessageDb();
    restoreChannelMessages();
    const run = vi.fn();
    drainChannelMessages(() => false, run);
    expect(run).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      groupId: "group", threadId: "old-thread", id: first.id, text: "continue goal",
      mode: "goal", via: "api", replyToId: "reply", sendId: "first",
    }));
    expect(journal.chatFollowups().find((row) => row.id === first.id)?.status).toBe("dispatching");
    drainChannelMessages(() => false, run);
    expect(run.mock.calls[1][0]).toMatchObject({ id: second.id, mode: "chat", text: "next" });
    await Promise.resolve();
    expect(journal.cancelledChatFollowup("channel", "group", "old-thread", "cancelled")).toBe(true);
  });

  it("does not publish or cancel in memory when its durable write fails", () => {
    const saved = queueSteeredMessage("bot", "thread", "keep");
    const save = vi.spyOn(journal, "saveChatFollowup").mockImplementation(() => { throw new Error("disk full"); });
    expect(() => queueSteeredMessage("bot", "thread", "not accepted")).toThrow("disk full");
    expect(() => queueChannelMessage("group", "channel", "not accepted")).toThrow("disk full");
    save.mockRestore();
    const channel = queueChannelMessage("group", "channel", "keep channel", { sendId: "channel-send" });
    const settle = vi.spyOn(journal, "settleChatFollowups").mockImplementation(() => { throw new Error("disk full"); });
    expect(() => cancelSteeredMessage("bot", saved.id)).toThrow("disk full");
    expect(() => cancelChannelMessage("group", channel.id)).toThrow("disk full");
    expect(queuedSteerSnapshot(() => true)).toEqual({ thread: [{ queueId: saved.id, text: "keep" }] });
    const store = storeFor("bot", "thread");
    const run = vi.fn();
    expect(() => drainSteeredMessages(store, run)).toThrow("disk full");
    expect(() => drainChannelMessages(() => false, run)).toThrow("disk full");
    expect(queuedChannelMessage("group", "channel", "channel-send")?.id).toBe(channel.id);
    expect(store.messages).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    settle.mockRestore();
  });

  it("never restores a claim whose dispatch may have started", async () => {
    const bot = queueSteeredMessage("bot", "thread", "possibly executed");
    const channel = queueChannelMessage("group", "channel", "possibly executed");
    expect(() => drainSteeredMessages(storeFor("bot", "thread"), () => { throw new Error("lost dispatch"); })).toThrow();
    drainChannelMessages(() => false, () => Promise.reject(new Error("lost channel dispatch")));
    await Promise.resolve();
    journal.closeMessageDb();
    restoreSteeredMessages();
    restoreChannelMessages();
    const run = vi.fn();
    drainSteeredMessages(storeFor("bot", "thread"), run);
    drainChannelMessages(() => false, run);
    expect(run).not.toHaveBeenCalled();
    expect(journal.chatFollowups()).toEqual([
      expect.objectContaining({ id: bot.id, status: "dispatching" }),
      expect.objectContaining({ id: channel.id, status: "interrupted" }),
    ]);
  });

  it("deleting a thread deletes pending work and cancellation tombstones", () => {
    queueSteeredMessage("bot", "thread", "pending");
    const cancelled = queueChannelMessage("group", "thread", "cancelled", { sendId: "old-id" });
    cancelChannelMessage("group", cancelled.id);
    journal.deleteThread("thread");
    journal.closeMessageDb();
    restoreSteeredMessages();
    restoreChannelMessages();
    expect(journal.chatFollowups()).toEqual([]);
    expect(queuedSteerSnapshot(() => true)).toEqual({});
    const run = vi.fn();
    drainChannelMessages(() => false, run);
    expect(run).not.toHaveBeenCalled();
  });
});
