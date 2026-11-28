import { describe, expect, it } from "vitest";
import { threadTurnStart } from "./thread-turn-start";

const room = { threadId: "current", busyBotId: "kiwi", turnStartedAt: 1_000 };

describe("a room thread's Thinking readout beside the feed", () => {
  it("counts the room's current thread from the server's stamp", () => {
    expect(threadTurnStart(room, { threadId: "current", working: true, busyBotId: "kiwi" }, new Map(), 9_000)).toBe(1_000);
  });

  it("counts another thread from when this window first saw it working, and starts again after it settles", () => {
    const seen = new Map<string, number>();
    const other = { threadId: "other", working: true, busyBotId: "pip" };
    expect(threadTurnStart(room, other, seen, 5_000)).toBe(5_000);
    expect(threadTurnStart(room, other, seen, 7_000)).toBe(5_000);
    expect(threadTurnStart(room, { threadId: "other", working: false, busyBotId: null }, seen, 8_000)).toBeNull();
    expect(threadTurnStart(room, other, seen, 9_000)).toBe(9_000);
  });

  it("does not take the room's stamp for its current thread when another member speaks there", () => {
    expect(threadTurnStart(room, { threadId: "current", working: true, busyBotId: "pip" }, new Map(), 4_000)).toBe(4_000);
  });
});
