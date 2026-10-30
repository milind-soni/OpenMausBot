import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ComputerIdleTimer } from "./computer-idle.ts";

describe("ComputerIdleTimer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("suspends only after a complete idle window", async () => {
    const suspend = vi.fn(async () => {});
    const idle = new ComputerIdleTimer(1_000, () => false, suspend);

    idle.touch();
    await vi.advanceTimersByTimeAsync(999);
    expect(suspend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(suspend).toHaveBeenCalledOnce();
  });

  it("renews the deadline on activity", async () => {
    const suspend = vi.fn(async () => {});
    const idle = new ComputerIdleTimer(1_000, () => false, suspend);

    idle.touch();
    await vi.advanceTimersByTimeAsync(700);
    idle.touch();
    await vi.advanceTimersByTimeAsync(700);
    expect(suspend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(suspend).toHaveBeenCalledOnce();
  });

  it("never suspends active work, and waits a full window from the first look that finds it quiet", async () => {
    let busy = true;
    const suspend = vi.fn(async () => {});
    const idle = new ComputerIdleTimer(1_000, () => busy, suspend);

    idle.touch();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(suspend).not.toHaveBeenCalled();
    busy = false;
    await vi.advanceTimersByTimeAsync(1_099);
    expect(suspend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(suspend).toHaveBeenCalledOnce();
  });

  it("looks again ten times a window while busy, so work ending late still gets a full quiet window", async () => {
    let busy = true;
    const looks: number[] = [];
    const suspend = vi.fn(async () => {});
    const idle = new ComputerIdleTimer(1_000, () => { looks.push(Date.now()); return busy; }, suspend);
    const start = Date.now();

    idle.touch();
    await vi.advanceTimersByTimeAsync(1_450);
    expect(looks.map(at => at - start)).toEqual([1_000, 1_100, 1_200, 1_300, 1_400]);
    busy = false;
    await vi.advanceTimersByTimeAsync(1_049);
    expect(suspend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(suspend).toHaveBeenCalledOnce();
  });

  it("can be cancelled after a manual stop", async () => {
    const suspend = vi.fn(async () => {});
    const idle = new ComputerIdleTimer(1_000, () => false, suspend);
    idle.touch();
    idle.cancel();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(suspend).not.toHaveBeenCalled();
  });

  it("shortens a pending deadline from the last activity when the window changes", async () => {
    const suspend = vi.fn(async () => {});
    const idle = new ComputerIdleTimer(10_000, () => false, suspend);

    idle.touch();
    await vi.advanceTimersByTimeAsync(600);
    idle.setIdleMs(1_000);
    await vi.advanceTimersByTimeAsync(399);
    expect(suspend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(suspend).toHaveBeenCalledOnce();
  });

  it("suspends promptly when the new window has already elapsed", async () => {
    const suspend = vi.fn(async () => {});
    const idle = new ComputerIdleTimer(10_000, () => false, suspend);

    idle.touch();
    await vi.advanceTimersByTimeAsync(5_000);
    idle.setIdleMs(1_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(suspend).toHaveBeenCalledOnce();
  });

  it("extends a pending deadline and uses the new window for later activity", async () => {
    const suspend = vi.fn(async () => {});
    const idle = new ComputerIdleTimer(1_000, () => false, suspend);

    idle.touch();
    await vi.advanceTimersByTimeAsync(500);
    idle.setIdleMs(3_000);
    await vi.advanceTimersByTimeAsync(2_499);
    expect(suspend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(suspend).toHaveBeenCalledOnce();

    idle.touch();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(suspend).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(suspend).toHaveBeenCalledTimes(2);
  });

  it("keeps protecting active work after the window changes", async () => {
    let busy = true;
    const suspend = vi.fn(async () => {});
    const idle = new ComputerIdleTimer(10_000, () => busy, suspend);

    idle.touch();
    await vi.advanceTimersByTimeAsync(5_000);
    idle.setIdleMs(1_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(suspend).not.toHaveBeenCalled();
    busy = false;
    await vi.advanceTimersByTimeAsync(1_099);
    expect(suspend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(suspend).toHaveBeenCalledOnce();
  });

  type Stop = { promise: Promise<void | "busy">; resolve: (outcome: void | "busy") => void; reject: (error: Error) => void };
  it.each([
    ["fails", (stop: Stop) => stop.reject(new Error("provider 503"))],
    ["finds work arrived", (stop: Stop) => stop.resolve("busy")],
  ])("stays cancelled when a stop already under way %s", async (_, settle) => {
    const stop = {} as Stop;
    stop.promise = new Promise((resolve, reject) => Object.assign(stop, { resolve, reject }));
    const suspend = vi.fn(() => stop.promise);
    const failed = vi.fn();
    const idle = new ComputerIdleTimer(1_000, () => false, suspend, failed);

    idle.touch();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(suspend).toHaveBeenCalledOnce();
    idle.cancel();
    settle(stop);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(suspend).toHaveBeenCalledOnce();
    expect(failed).not.toHaveBeenCalled();
  });

  it("does not arm a cancelled timer when the window changes", async () => {
    const suspend = vi.fn(async () => {});
    const idle = new ComputerIdleTimer(1_000, () => false, suspend);
    idle.touch();
    idle.cancel();
    idle.setIdleMs(500);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(suspend).not.toHaveBeenCalled();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects a non-positive window: %s", (idleMs) => {
    expect(() => new ComputerIdleTimer(idleMs, () => false, async () => {})).toThrow("positive");
    expect(() => new ComputerIdleTimer(1_000, () => false, async () => {}).setIdleMs(idleMs)).toThrow("positive");
  });

  it("re-arms after a transient suspension failure", async () => {
    const suspend = vi.fn().mockRejectedValueOnce(new Error("runtime unavailable")).mockResolvedValue(undefined);
    const idle = new ComputerIdleTimer(1_000, () => false, suspend);

    idle.touch();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(suspend).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(suspend).toHaveBeenCalledTimes(2);
  });

  it("backs a failing stop off: one window, then two, then four, never more than an hour apart", async () => {
    const minute = 60_000;
    const attempts: number[] = [];
    const retries: number[] = [];
    const suspend = vi.fn(async () => { attempts.push(Date.now()); throw new Error("provider 503"); });
    const idle = new ComputerIdleTimer(10 * minute, () => false, suspend, (_error, retryInMs) => retries.push(retryInMs));
    const start = Date.now();

    idle.touch();
    await vi.advanceTimersByTimeAsync(5 * 60 * minute);
    expect(attempts.map(at => (at - start) / minute)).toEqual([10, 20, 40, 80, 140, 200, 260]);
    expect(retries.map(ms => ms / minute)).toEqual([10, 20, 40, 60, 60, 60, 60]);
  });

  it("a touch after failures starts a full window again, with the backoff reset", async () => {
    const suspend = vi.fn().mockRejectedValueOnce(new Error("down")).mockRejectedValueOnce(new Error("down")).mockResolvedValue(undefined);
    const idle = new ComputerIdleTimer(1_000, () => false, suspend);

    idle.touch();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(suspend).toHaveBeenCalledTimes(2);
    idle.touch();
    await vi.advanceTimersByTimeAsync(999);
    expect(suspend).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(suspend).toHaveBeenCalledTimes(3);
  });

  it("work that arrived during the stop keeps the computer on for another full window", async () => {
    const suspend = vi.fn<() => Promise<void | "busy">>().mockResolvedValueOnce("busy").mockResolvedValue(undefined);
    const failed = vi.fn();
    const idle = new ComputerIdleTimer(1_000, () => false, suspend, failed);

    idle.touch();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(suspend).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(suspend).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(suspend).toHaveBeenCalledTimes(2);
    expect(failed).not.toHaveBeenCalled();
  });
});
