import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { closeMessageDb } from "./message-db.ts";
import { Store } from "./store.ts";
import { THREAD_IDLE_MS } from "./thread-cache.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

describe("Store message cache", () => {
  let now: number;

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    now = Date.UTC(2026, 9, 1, 9);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  const later = (ms: number) => {
    now += ms;
    vi.setSystemTime(now);
  };

  it("lets an idle conversation go and reloads it unchanged", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Idle" });
    const other = store.createTask(bot.id, "Other", false)!;
    const first = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "first" });
    const reply = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "reply" });
    store.patchMessage(bot.threadId, reply.id, { text: "edited reply" });
    store.branchMessage(bot.threadId, first.id, "second try");
    for (let i = 0; i < 5; i++) store.appendMessage(bot.threadId, { role: "bot", kind: "screen", png: `frame-${i}`, mime: "image/png" });
    const before = store.messagesFor(bot.threadId);
    const snapshot = structuredClone({ messages: before, leaf: store.activeLeaf(bot.threadId), path: store.activePath(bot.threadId) });

    later(THREAD_IDLE_MS + 1);
    store.messagesFor(other.threadId);

    const after = store.messagesFor(bot.threadId);
    expect(after).not.toBe(before);
    expect({ messages: after, leaf: store.activeLeaf(bot.threadId), path: store.activePath(bot.threadId) }).toEqual(snapshot);
  });

  it("keeps a conversation someone used within the idle window", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Recent" });
    const other = store.createTask(bot.id, "Other", false)!;
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hello" });
    const before = store.messagesFor(bot.threadId);

    later(THREAD_IDLE_MS / 2);
    store.messagesFor(bot.threadId);
    later(THREAD_IDLE_MS / 2 + 1);
    store.messagesFor(other.threadId);

    expect(store.messagesFor(bot.threadId)).toBe(before);
  });

  it("keeps a conversation whose turn is still running, however long it is quiet", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Busy" });
    const other = store.createTask(bot.id, "Other", false)!;
    const room = store.createGroup("Room", [bot.id]);
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "long job" });
    store.appendMessage(room.threadId, { role: "user", kind: "text", text: "room job" });
    store.setTaskActivity(bot.id, bot.threadId, "working");
    store.patchGroup(room.id, { busyBotId: bot.id });
    const direct = store.messagesFor(bot.threadId);
    const roomLines = store.messagesFor(room.threadId);

    later(THREAD_IDLE_MS * 3);
    store.messagesFor(other.threadId);

    expect(store.messagesFor(bot.threadId)).toBe(direct);
    expect(store.messagesFor(room.threadId)).toBe(roomLines);
  });

  it("writes that land after a reload are kept", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Writer" });
    const other = store.createTask(bot.id, "Other", false)!;
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "before" });

    later(THREAD_IDLE_MS + 1);
    store.messagesFor(other.threadId);
    const added = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "after" });

    expect(store.messagesFor(bot.threadId).map((message) => message.text)).toEqual(
      new Store(selection).messagesFor(bot.threadId).map((message) => message.text),
    );
    expect(store.activeLeaf(bot.threadId)).toBe(added.id);
  });
});
