import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_ROOM_COMPACT_AT, roomCompactTokens, RoomContextTracker } from "./room-context.ts";

const IDLE_MS = 10 * 60_000;

describe("room context", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("reads roomCompactAt like compactAt and follows autoCompact", () => {
    expect(DEFAULT_ROOM_COMPACT_AT).toBe(0.9);
    expect(roomCompactTokens(200_000, undefined)).toBe(180_000);
    expect(roomCompactTokens(200_000, { roomCompactAt: 0.5 })).toBe(100_000);
    expect(roomCompactTokens(200_000, { roomCompactAt: 50_000 })).toBe(50_000);
    expect(roomCompactTokens(200_000, { autoCompact: false })).toBeNull();
  });

  it("measures each member per room thread, with the model's window when the driver gave none", () => {
    const rooms = new RoomContextTracker({ idleMs: IDLE_MS });
    rooms.record("room", "scout", { tokens: 0 }, "claude-sonnet-4");
    rooms.record("room", "scout", { tokens: 120_000 }, "claude-sonnet-4");
    rooms.record("room", "pixel", { tokens: 10_000, window: 50_000 }, "anything");
    expect(rooms.forThread("room")).toEqual({
      scout: { tokens: 120_000, window: 200_000 },
      pixel: { tokens: 10_000, window: 50_000 },
    });
    expect(rooms.forThread("other")).toBeUndefined();
  });

  it("starts the next turn fresh at the threshold, once per reading", () => {
    const rooms = new RoomContextTracker({ idleMs: IDLE_MS });
    rooms.record("room", "scout", { tokens: 179_999, window: 200_000 }, undefined);
    expect(rooms.takeReset("room", "scout", undefined)).toBeNull();
    rooms.record("room", "scout", { tokens: 184_000, window: 200_000 }, undefined);
    expect(rooms.takeReset("room", "scout", { autoCompact: false })).toBeNull();
    expect(rooms.takeReset("room", "scout", undefined)).toEqual({ reason: "threshold", percent: 92 });
    expect(rooms.takeReset("room", "scout", undefined)).toBeNull();
    expect(rooms.forThread("room")).toBeUndefined();
  });

  it("honours Compact now even with automatic compaction off, and keeps it across a later reading", () => {
    const rooms = new RoomContextTracker({ idleMs: IDLE_MS });
    expect(rooms.request("room", "scout")).toBe(false);
    rooms.record("room", "scout", { tokens: 40_000, window: 200_000 }, undefined);
    expect(rooms.request("room", "scout")).toBe(true);
    expect(rooms.forThread("room")).toEqual({ scout: { tokens: 40_000, window: 200_000, compactRequested: true } });
    rooms.record("room", "scout", { tokens: 60_000, window: 200_000 }, undefined);
    expect(rooms.takeReset("room", "scout", { autoCompact: false })).toEqual({ reason: "requested", percent: 30 });
    expect(rooms.takeReset("room", "pixel", undefined)).toBeNull();
  });

  it("drops other members' readings when a turn takes their engine's warm process", () => {
    const rooms = new RoomContextTracker({ idleMs: IDLE_MS });
    rooms.dispatched("room", "editor1", "claude");
    rooms.record("room", "editor1", { tokens: 162_000, window: 200_000 }, undefined);
    expect(rooms.request("room", "editor1")).toBe(true);
    rooms.dispatched("room", "codex-bot", "codex");
    rooms.record("room", "codex-bot", { tokens: 30_000, window: 200_000 }, undefined);
    expect(rooms.dispatched("room", "codex-bot", "codex")).toBe(false);
    expect(Object.keys(rooms.forThread("room") ?? {})).toEqual(["editor1", "codex-bot"]);
    expect(rooms.dispatched("room", "editor3", "claude")).toBe(true);
    expect(rooms.forThread("room")).toEqual({ "codex-bot": { tokens: 30_000, window: 200_000 } });
    expect(rooms.takeReset("room", "editor1", undefined)).toBeNull();
    expect(rooms.request("room", "editor1")).toBe(false);
    rooms.record("room", "editor3", { tokens: 190_000, window: 200_000 }, undefined);
    expect(rooms.dispatched("room", "editor3", "claude")).toBe(false);
    expect(rooms.forThread("room")?.editor3).toEqual({ tokens: 190_000, window: 200_000 });
  });

  it("forgets a reading once its process has idled out, unless a keep-warm hold keeps it", () => {
    vi.useFakeTimers({ now: 1_000_000 });
    let heldUntil: number | undefined;
    const expired: string[] = [];
    const rooms = new RoomContextTracker({ idleMs: IDLE_MS, heldUntil: () => heldUntil, expired: (threadId) => expired.push(threadId) });
    rooms.record("room", "editor1", { tokens: 162_000, window: 200_000 }, undefined);
    rooms.request("room", "editor1");
    vi.advanceTimersByTime(IDLE_MS - 1);
    expect(rooms.forThread("room")?.editor1?.compactRequested).toBe(true);
    heldUntil = Date.now() + 5 * 60_000;
    vi.advanceTimersByTime(1);
    expect(expired).toEqual([]);
    expect(rooms.forThread("room")?.editor1).toBeDefined();
    vi.advanceTimersByTime(5 * 60_000);
    expect(expired).toEqual(["room"]);
    expect(rooms.forThread("room")).toBeUndefined();
    expect(rooms.request("room", "editor1")).toBe(false);
    expect(rooms.takeReset("room", "editor1", undefined)).toBeNull();

    rooms.record("room", "editor1", { tokens: 190_000, window: 200_000 }, undefined);
    expect(rooms.takeReset("room", "editor1", undefined)).toEqual({ reason: "threshold", percent: 95 });
    heldUntil = undefined;
    vi.advanceTimersByTime(IDLE_MS);
    expect(expired).toEqual(["room"]);
  });
});
