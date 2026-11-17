import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { DATA_DIR } from "./config.ts";
import { closeMessageDb } from "./message-db.ts";
import { approxBytes, ThreadCache } from "./thread-cache.ts";
import { Store, type Message } from "./store.ts";

const START = 1_000_000;
const rows = (id: string) => ({ messages: [{ id, at: 1, role: "user", kind: "text", text: "x".repeat(10_000) } as Message], activeLeafId: id });

describe("read-only access after transcript cache protections expire", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(START); });
  afterEach(() => vi.useRealTimers());

  it("retries byte eviction after a burst of recent loads, keeping the requested transcript", () => {
    const cache = new ThreadCache(() => new Set(), 25_000);
    const states = ["a", "b", "c", "d"].map((id) => cache.load(id, rows(id)));
    expect(cache.size).toBe(4); // all are inside the minimum residency window
    vi.setSystemTime(START + 5_001);

    expect(cache.get("d")).toBe(states[3]);

    expect(cache.approxBytes).toBeLessThanOrEqual(25_000);
    expect(cache.size).toBe(2);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe(states[2]);
  });

  it("reclaims a formerly busy transcript after its turn ends without requiring another write", () => {
    const busy = new Set(["busy"]);
    const cache = new ThreadCache(() => busy, 15_000);
    const work = cache.load("busy", rows("busy"));
    const shown = cache.load("shown", rows("shown"));
    vi.setSystemTime(START + 5_001);
    expect(cache.get("shown")).toBe(shown);
    expect(cache.size).toBe(2); // the other transcript is still busy
    busy.clear();
    vi.setSystemTime(START + 10_002);

    expect(cache.get("shown")).toBe(shown);

    expect(cache.get("busy")).toBeUndefined();
    expect(cache.approxBytes).toBeLessThanOrEqual(15_000);
    expect(work.messages[0]!.text).toHaveLength(10_000); // eviction never mutates a caller's value
  });

  it("refreshes the requested entry before choosing the least recently used victim", () => {
    const cache = new ThreadCache(() => new Set(), 25_000);
    const oldest = cache.load("oldest", rows("oldest"));
    cache.load("middle", rows("middle"));
    const newest = cache.load("newest", rows("newest"));
    vi.setSystemTime(START + 5_001);

    expect(cache.get("oldest")).toBe(oldest);

    expect(cache.get("middle")).toBeUndefined();
    expect(cache.get("newest")).toBe(newest);
    expect(cache.approxBytes).toBe(approxBytes(oldest.messages[0]) + approxBytes(newest.messages[0]));
  });

  it("keeps busy and requested transcripts while over budget", () => {
    const busy = new Set(["busy"]);
    const cache = new ThreadCache(() => busy, 1_000);
    const work = cache.load("busy", rows("busy"));
    const current = cache.load("current", rows("current"));
    vi.setSystemTime(START + 4_999);
    expect(cache.get("current")).toBe(current);
    expect(cache.size).toBe(2);
    vi.setSystemTime(START + 10_000);
    expect(cache.get("current")).toBe(current);
    expect(cache.get("busy")).toBe(work);
    expect(cache.size).toBe(2);
  });

  it("protects an unrequested recently used transcript until its residency expires", () => {
    const cache = new ThreadCache(() => new Set(), 15_000);
    const a = cache.load("a", rows("a"));
    const b = cache.load("b", rows("b"));
    expect(cache.approxBytes).toBeGreaterThan(15_000);
    vi.setSystemTime(START + 4_999);
    expect(cache.get("a")).toBe(a);
    vi.setSystemTime(START + 5_000);
    expect(cache.get("b")).toBe(b);
    expect(cache.size).toBe(2);

    vi.setSystemTime(START + 10_000);
    expect(cache.get("b")).toBe(b);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(1);
    expect(cache.approxBytes).toBeLessThanOrEqual(15_000);
  });

  it("bounds deferred-eviction scans while all over-budget transcripts are protected", () => {
    const busy = new Set(["busy"]);
    const busyIds = vi.fn(() => busy);
    const cache = new ThreadCache(busyIds, 1_000);
    cache.load("busy", rows("busy"));
    cache.load("current", rows("current"));
    busyIds.mockClear();
    vi.setSystemTime(START + 5_001);
    for (let read = 0; read < 100; read++) expect(cache.get("current")).toBeDefined();
    expect(busyIds).toHaveBeenCalledTimes(1);
  });
});

it("Store reloads an evicted transcript with the same messages and active leaf", () => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
  try {
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    const cache = new ThreadCache(() => new Set(), 25_000);
    (store as unknown as { threads: ThreadCache }).threads = cache;
    const bot = store.createBot({ name: "Cache fixture" }, { seedMessages: false });
    const second = store.createTask(bot.id, "Second", false)!;
    const third = store.createTask(bot.id, "Third", false)!;
    for (const thread of [bot.threadId, second.threadId, third.threadId]) {
      store.appendMessage(thread, { role: "user", kind: "text", text: "x".repeat(10_000) });
    }
    const secondBefore = store.messagesFor(second.threadId);
    const secondExpected = structuredClone(secondBefore);
    const secondLeaf = store.activeLeaf(second.threadId);
    const before = store.messagesFor(bot.threadId);
    const leaf = store.activeLeaf(bot.threadId);
    const expected = structuredClone(before);
    vi.setSystemTime(START + 5_001);
    store.messagesFor(third.threadId);
    expect(cache.approxBytes).toBeLessThanOrEqual(25_000);
    expect(cache.get(second.threadId)).toBeUndefined();
    // Read the evicted conversation through Store, which reloads messages.db.
    const reloaded = store.messagesFor(second.threadId);
    expect(reloaded).not.toBe(secondBefore);
    expect(reloaded).toEqual(secondExpected);
    expect(store.activeLeaf(second.threadId)).toBe(secondLeaf);
    expect(store.messagesFor(bot.threadId)).toEqual(expected);
    expect(store.activeLeaf(bot.threadId)).toBe(leaf);
  } finally {
    vi.useRealTimers();
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
  }
});
