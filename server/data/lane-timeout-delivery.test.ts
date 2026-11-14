import { afterEach, describe, expect, it, vi } from "vitest";

import { Lane } from "./engine.ts";
import { DataFailure } from "./types.ts";

afterEach(() => vi.useRealTimers());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("data interruptions after the statement deadline", () => {
  it.each(["timeout", "cancelled"] as const)("delivers %s after native dispatch and releases the next statement", async (cause) => {
    vi.useFakeTimers();
    const atWork = deferred<void>();
    const dispatch = deferred<void>();
    const query = deferred<string>();
    const controller = new AbortController();
    let dispatched = false;
    const interrupt = vi.fn(() => {
      if (dispatched) query.reject(new Error("INTERRUPT Error: Interrupted!"));
    });
    const lane = new Lane({ interrupt } as never);
    let outcome: { value?: string; error?: unknown } | undefined;
    const running = lane.run("delayed statement", { timeoutMs: 20, signal: controller.signal }, async () => {
      atWork.resolve();
      await dispatch.promise;
      dispatched = true;
      return query.promise;
    }).then((value) => { outcome = { value }; }, (error: unknown) => { outcome = { error }; });
    try {
      await atWork.promise;
      if (cause === "cancelled") controller.abort();
      await vi.advanceTimersByTimeAsync(20);
      expect(interrupt).toHaveBeenCalled();
      expect(dispatched).toBe(false);
      dispatch.resolve();
      await vi.advanceTimersByTimeAsync(10);

      expect(outcome?.error).toBeInstanceOf(DataFailure);
      expect((outcome!.error as DataFailure).error.code).toBe(cause);
      expect(vi.getTimerCount()).toBe(0);
      const delivered = interrupt.mock.calls.length;
      await expect(lane.run("next statement", { timeoutMs: 20 }, async () => "next result")).resolves.toBe("next result");
      await vi.advanceTimersByTimeAsync(100);
      expect(interrupt).toHaveBeenCalledTimes(delivered);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      dispatch.resolve();
      query.resolve("completed");
      await running;
    }
  });
});
