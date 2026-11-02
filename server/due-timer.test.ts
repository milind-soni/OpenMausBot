import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DUE_MAX_SLEEP_MS, startDueTimer } from "./due-timer.ts";

describe("startDueTimer", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("runs once at start, then only at the next due time, capped for a machine that slept", async () => {
    const runs: number[] = [];
    let due: number | null = Date.now() + 90_000;
    const timer = startDueTimer({ run: () => { runs.push(Date.now()); if (Date.now() >= due!) due = null; }, next: () => due });
    const start = Date.now();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toEqual([start]);
    await vi.advanceTimersByTimeAsync(89_999);
    expect(runs.map((at) => at - start)).toEqual([0, DUE_MAX_SLEEP_MS]);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs.map((at) => at - start)).toEqual([0, DUE_MAX_SLEEP_MS, 90_000]);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(runs).toHaveLength(3 + 10);
    timer.stop();
  });

  it("wakes at most once a minute with nothing due", async () => {
    const run = vi.fn();
    const timer = startDueTimer({ run, next: () => null });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(run).toHaveBeenCalledTimes(1 + 60);
    timer.stop();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(run).toHaveBeenCalledTimes(1 + 60);
  });

  it("brings the run forward when a change makes work due sooner, and never pushes a nearer run back", async () => {
    const runs: number[] = [];
    let due: number | null = null;
    const timer = startDueTimer({ run: () => { runs.push(Date.now()); due = null; }, next: () => due });
    const start = Date.now();
    await vi.advanceTimersByTimeAsync(0);
    due = start + 5_000;
    timer.poke();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runs.map((at) => at - start)).toEqual([0, 5_000]);
    due = Date.now();
    timer.poke();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs.map((at) => at - start)).toEqual([0, 5_000, 5_000]);
    timer.stop();
  });

  it("retries work still due after a run (waiting on something outside) every retryMs, not in a tight loop", async () => {
    const run = vi.fn();
    const timer = startDueTimer({ run, next: () => Date.now() - 1, retryMs: 5_000 });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(run).toHaveBeenCalledTimes(1 + 4);
    timer.stop();
  });

  it("runs again straight after a run that a change interrupted with work due now", async () => {
    let release!: () => void;
    const calls: number[] = [];
    let due: number | null = null;
    const timer = startDueTimer({
      run: () => { calls.push(Date.now()); if (calls.length === 2) return new Promise<void>((resolve) => { release = resolve; }); due = null; },
      next: () => due,
    });
    await vi.advanceTimersByTimeAsync(0);
    due = Date.now();
    timer.poke();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2);
    timer.poke();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(3);
    timer.stop();
  });
});
