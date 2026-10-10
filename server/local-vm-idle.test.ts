import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LocalVmIdleTimer } from "./local-vm-idle.ts";

describe("LocalVmIdleTimer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("suspends only after a complete idle window", async () => {
    const suspend = vi.fn(async () => {});
    const idle = new LocalVmIdleTimer(1_000, () => false, suspend);

    idle.touch();
    await vi.advanceTimersByTimeAsync(999);
    expect(suspend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(suspend).toHaveBeenCalledOnce();
  });

  it("renews the deadline on activity", async () => {
    const suspend = vi.fn(async () => {});
    const idle = new LocalVmIdleTimer(1_000, () => false, suspend);

    idle.touch();
    await vi.advanceTimersByTimeAsync(700);
    idle.touch();
    await vi.advanceTimersByTimeAsync(700);
    expect(suspend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(suspend).toHaveBeenCalledOnce();
  });

  it("never suspends active work and retries after another full window", async () => {
    let busy = true;
    const suspend = vi.fn(async () => {});
    const idle = new LocalVmIdleTimer(1_000, () => busy, suspend);

    idle.touch();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(suspend).not.toHaveBeenCalled();
    busy = false;
    await vi.advanceTimersByTimeAsync(999);
    expect(suspend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(suspend).toHaveBeenCalledOnce();
  });

  it("can be cancelled after a manual stop", async () => {
    const suspend = vi.fn(async () => {});
    const idle = new LocalVmIdleTimer(1_000, () => false, suspend);
    idle.touch();
    idle.cancel();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(suspend).not.toHaveBeenCalled();
  });

  it("shortens a pending deadline from the last activity when the window changes", async () => {
    const suspend = vi.fn(async () => {});
    const idle = new LocalVmIdleTimer(10_000, () => false, suspend);

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
    const idle = new LocalVmIdleTimer(10_000, () => false, suspend);

    idle.touch();
    await vi.advanceTimersByTimeAsync(5_000);
    idle.setIdleMs(1_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(suspend).toHaveBeenCalledOnce();
  });

  it("extends a pending deadline and uses the new window for later activity", async () => {
    const suspend = vi.fn(async () => {});
    const idle = new LocalVmIdleTimer(1_000, () => false, suspend);

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
    const idle = new LocalVmIdleTimer(10_000, () => busy, suspend);

    idle.touch();
    await vi.advanceTimersByTimeAsync(5_000);
    idle.setIdleMs(1_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(suspend).not.toHaveBeenCalled();
    busy = false;
    await vi.advanceTimersByTimeAsync(999);
    expect(suspend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(suspend).toHaveBeenCalledOnce();
  });

  it("does not arm a cancelled timer when the window changes", async () => {
    const suspend = vi.fn(async () => {});
    const idle = new LocalVmIdleTimer(1_000, () => false, suspend);
    idle.touch();
    idle.cancel();
    idle.setIdleMs(500);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(suspend).not.toHaveBeenCalled();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects a non-positive window: %s", (idleMs) => {
    expect(() => new LocalVmIdleTimer(idleMs, () => false, async () => {})).toThrow("positive");
    expect(() => new LocalVmIdleTimer(1_000, () => false, async () => {}).setIdleMs(idleMs)).toThrow("positive");
  });

  it("re-arms after a transient suspension failure", async () => {
    const suspend = vi.fn().mockRejectedValueOnce(new Error("runtime unavailable")).mockResolvedValue(undefined);
    const idle = new LocalVmIdleTimer(1_000, () => false, suspend);

    idle.touch();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(suspend).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(suspend).toHaveBeenCalledTimes(2);
  });
});
