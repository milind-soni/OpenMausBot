import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createHandoffTicks, HANDOFF_TICK_MS, type HandoffPace } from "./handoff-ticks.ts";

describe("hand-off ticks", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("ticks every 250 ms only while work is moving, rarely while it is parked, and hourly with none", async () => {
    let pace: HandoffPace = "busy";
    const tick = vi.fn();
    const ticks = createHandoffTicks();
    ticks.start({ tick, pace: () => pace });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tick).toHaveBeenCalledTimes(4);
    pace = "parked";
    await vi.advanceTimersByTimeAsync(250 + 60_000);
    expect(tick).toHaveBeenCalledTimes(5 + 6);
    pace = "idle";
    tick.mockClear();
    await vi.advanceTimersByTimeAsync(HANDOFF_TICK_MS.parked + 3 * 60 * 60_000);
    expect(tick).toHaveBeenCalledTimes(1 + 3);
    ticks.stop();
  });

  it("ticks at once when a write lands while idle, and a kick during busy ticks keeps the 250 ms pace", async () => {
    let pace: HandoffPace = "idle";
    const tick = vi.fn();
    const ticks = createHandoffTicks();
    ticks.kick();
    ticks.start({ tick, pace: () => pace });
    await vi.advanceTimersByTimeAsync(250);
    expect(tick).toHaveBeenCalledTimes(1);
    pace = "busy";
    ticks.kick();
    ticks.kick();
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(2);
    ticks.kick();
    await vi.advanceTimersByTimeAsync(249);
    expect(tick).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(3);
    ticks.stop();
    ticks.kick();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it("keeps ticking after a tick throws", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const tick = vi.fn(() => { throw new Error("boom"); });
    const ticks = createHandoffTicks();
    ticks.start({ tick, pace: () => "idle" });
    await vi.advanceTimersByTimeAsync(750);
    expect(tick).toHaveBeenCalledTimes(3);
    expect(errors).toHaveBeenCalled();
    ticks.stop();
    errors.mockRestore();
  });
});
