import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { interruptibleDelay } from "./retry.ts";

describe("interruptibleDelay cleanup", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("releases the abort listener after the backoff elapses", async () => {
    const controller = new AbortController();
    const wait = interruptibleDelay(100, controller.signal);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(100);

    await expect(wait.promise).resolves.toBe("elapsed");
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    wait.cancel();
    await expect(wait.promise).resolves.toBe("elapsed");
  });

  it("does not leave a timer behind for an already aborted turn", async () => {
    const controller = new AbortController();
    controller.abort();

    const wait = interruptibleDelay(100, controller.signal);

    await expect(wait.promise).resolves.toBe("cancelled");
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it.each(["cancel", "abort"] as const)("releases the timer and listener on %s", async (action) => {
    const controller = new AbortController();
    const wait = interruptibleDelay(100, controller.signal);

    if (action === "cancel") wait.cancel();
    else controller.abort();

    await expect(wait.promise).resolves.toBe("cancelled");
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    wait.cancel();
    await expect(wait.promise).resolves.toBe("cancelled");
  });

  it("can cancel a wait without an AbortSignal", async () => {
    const wait = interruptibleDelay(100);
    wait.cancel();
    await expect(wait.promise).resolves.toBe("cancelled");
    expect(vi.getTimerCount()).toBe(0);
  });
});
