import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { closeMessageDb } from "./message-db.ts";
import { Store } from "./store.ts";
import { approxBytes, ThreadCache, THREAD_IDLE_MS } from "./thread-cache.ts";
import type { Message } from "./store.ts";

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

describe("ThreadCache byte cap", () => {
  const text = (id: string, size: number): Message => ({ id, at: 1, role: "bot", kind: "text", text: "x".repeat(size) }) as Message;
  const rows = (id: string, size: number) => ({ messages: [text(`${id}-1`, size)], activeLeafId: null });
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(1_000_000); });
  afterEach(() => { vi.useRealTimers(); });

  it("gives back the least recently used transcripts past the cap, never a busy one, the one just read, or one read moments ago", () => {
    const busy = new Set<string>();
    const cache = new ThreadCache(() => busy, 30_000);
    for (const id of ["a", "b", "c"]) cache.load(id, rows(id, 9_000));
    vi.setSystemTime(1_000_000 + 10_000);
    busy.add("a");
    cache.get("b");
    cache.load("d", rows("d", 9_000));
    // a is busy, b was just read again, so c (least recently used of the rest) goes.
    expect(["a", "b", "c", "d"].filter((id) => cache.get(id))).toEqual(["a", "b", "d"]);
    expect(cache.approxBytes).toBeLessThanOrEqual(30_000);

    vi.setSystemTime(1_000_000 + 20_000);
    cache.load("huge", rows("huge", 100_000));
    expect(cache.get("huge")).toBeDefined();
    expect(cache.get("a")).toBeDefined();
    expect(cache.size).toBe(2);
  });

  it("counts what a transcript gains and loses, and what a delete gives back", () => {
    const cache = new ThreadCache(() => new Set(), 1_000_000);
    cache.load("a", rows("a", 1_000));
    const before = cache.approxBytes;
    const added = text("a-2", 5_000);
    cache.grew("a", added);
    expect(cache.approxBytes).toBe(before + approxBytes(added));
    cache.grew("a", text("a-2", 2_000), added);
    expect(cache.approxBytes).toBe(before + approxBytes(text("a-2", 2_000)));
    cache.grew("nobody", added);
    cache.delete("a");
    expect(cache.approxBytes).toBe(0);
  });
});

describe("the transcript cache's count of a thread with live screens", () => {
  beforeEach(() => { rmSync(DATA_DIR, { recursive: true, force: true }); });
  afterEach(() => { closeMessageDb(); });

  it("gives back what pruned screen frames held, so many frames do not fill the cap", () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    const cache = (store as unknown as { threads: ThreadCache }).threads;
    const frame = "x".repeat(200_000);
    for (let i = 0; i < 50; i++) store.appendMessage(bot.threadId, { role: "bot", kind: "screen", png: frame } as never);
    const kept = store.messagesFor(bot.threadId).filter((message) => message.kind === "screen" && message.png).length;
    expect(kept).toBe(4);
    expect(cache.approxBytes).toBeLessThan(5 * 200_000 + 100_000);
  });
});
