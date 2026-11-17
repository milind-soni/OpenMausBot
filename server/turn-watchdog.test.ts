import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTurnWatchdog, formatDuration, type TurnExpiry } from "./turn-watchdog.ts";

describe("room turn watchdog", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = (idleMs = 1_000, maxMs = 10_000) => {
    const expired: TurnExpiry[] = [];
    const dog = createTurnWatchdog({ idleMs, maxMs, onExpire: (reason) => expired.push(reason) });
    return { dog, expired };
  };

  it("lets a continuously active turn run past the idle window", () => {
    const { dog, expired } = make();
    for (let i = 0; i < 8; i++) {
      vi.advanceTimersByTime(900);
      dog.activity();
    }
    expect(expired).toEqual([]);
    dog.stop();
  });

  it("expires a turn that goes quiet", () => {
    const { expired } = make();
    vi.advanceTimersByTime(999);
    expect(expired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(expired).toEqual(["idle"]);
  });

  it("pauses the idle clock while an approval is pending", () => {
    const { dog, expired } = make();
    dog.requestOpened("r1");
    vi.advanceTimersByTime(5_000);
    expect(expired).toEqual([]);
    dog.requestResolved("r1");
    vi.advanceTimersByTime(1_000);
    expect(expired).toEqual(["idle"]);
  });

  it("still enforces the safety ceiling on an active turn, exactly once", () => {
    const { dog, expired } = make(1_000, 3_000);
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(500);
      dog.activity();
    }
    expect(expired).toEqual(["max"]);
  });

  it("stop() cancels both clocks", () => {
    const { dog, expired } = make();
    dog.stop();
    vi.advanceTimersByTime(20_000);
    expect(expired).toEqual([]);
  });

  it("formats durations for the activity line", () => {
    expect(formatDuration(20 * 60_000)).toBe("20 min");
    expect(formatDuration(3 * 60 * 60_000)).toBe("3 h");
    expect(formatDuration(90 * 60_000)).toBe("1 h 30 min");
  });
});
