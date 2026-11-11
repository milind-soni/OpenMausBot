import { beforeEach, describe, expect, it, vi } from "vitest";

import { drainChannelMessages, queueChannelMessage, restoreChannelMessages } from "./channel-queue.ts";
import { chatFollowups, settleChatFollowups } from "./message-db.ts";
import { drainSteeredMessages, queueSteeredMessage, restoreSteeredMessages, type SteerStore } from "./steer-queue.ts";
import type { BotRecord } from "./store.ts";

beforeEach(() => {
  settleChatFollowups(chatFollowups().map((row) => row.id), null);
  restoreChannelMessages();
  restoreSteeredMessages();
});

function bot(id: string): BotRecord {
  return {
    id, threadId: id, name: id, title: "", description: "", notifications: false,
    color: "green", unread: false, modelSelection: { instanceId: "fake", model: "fake-model" },
    resumeCursors: {}, busy: false, createdAt: 0,
  };
}

describe.each(["throw", "reject"] as const)("queue dispatch failure: %s", (failure) => {
  function fail(): Promise<void> {
    const error = new Error("dispatch failed");
    if (failure === "throw") throw error;
    return Promise.reject(error);
  }

  it("settles the failed channel dispatch and continues other threads", async () => {
    const failed = queueChannelMessage("group", "failed", "first");
    const next = queueChannelMessage("group", "next", "second");
    const run = vi.fn(({ threadId }: { threadId: string }) => threadId === "failed" ? fail() : undefined);
    expect(() => drainChannelMessages(() => false, run)).not.toThrow();
    expect(run).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    expect(chatFollowups().find((row) => row.id === failed.id)?.status).toBe("interrupted");
    expect(chatFollowups().find((row) => row.id === next.id)).toBeUndefined();
    restoreChannelMessages();
    drainChannelMessages(() => false, run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("settles the failed bot dispatch and continues other threads", async () => {
    const bots = [bot("failed"), bot("next")];
    let messageId = 0;
    const store: SteerStore = {
      bot: (id) => bots.find((item) => item.id === id) ?? null,
      appendMessage: (_threadId, message) => ({ ...message, id: `m${++messageId}`, at: 0 }),
      patchMessage: () => null,
    };
    const failed = queueSteeredMessage("failed", "failed", "first");
    const next = queueSteeredMessage("next", "next", "second");
    const run = vi.fn((botId: string) => botId === "failed" ? fail() : undefined);
    expect(() => drainSteeredMessages(store, run)).not.toThrow();
    expect(run).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    expect(chatFollowups().find((row) => row.id === failed.id)?.status).toBe("interrupted");
    expect(chatFollowups().find((row) => row.id === next.id)).toBeUndefined();
    restoreSteeredMessages();
    drainSteeredMessages(store, run);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
