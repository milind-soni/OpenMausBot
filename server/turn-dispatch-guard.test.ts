import { describe, expect, it, vi } from "vitest";

import { PendingTurnCancellations, RetiredTurnRegistry, guardTurnDispatch } from "./turn-dispatch-guard.ts";

describe("turn dispatch cancellation boundary", () => {
  it("interrupts again after a provider setup that was cancelled while pending", async () => {
    let finishSetup!: (value: { turnId: string }) => void;
    const started = new Promise<{ turnId: string }>((resolve) => {
      finishSetup = resolve;
    });
    let cancelled = false;
    const stopAfterSetup = vi.fn(async () => {});
    const guarded = guardTurnDispatch(started, () => cancelled, stopAfterSetup);

    cancelled = true;
    finishSetup({ turnId: "turn-1" });

    await expect(guarded).resolves.toEqual({ value: { turnId: "turn-1" }, cancelled: true });
    expect(stopAfterSetup).toHaveBeenCalledOnce();
  });

  it("does not interrupt a setup that still owns its dispatch", async () => {
    const stopAfterSetup = vi.fn(async () => {});
    await expect(guardTurnDispatch(
      Promise.resolve({ turnId: "turn-2" }),
      () => false,
      stopAfterSetup,
    )).resolves.toEqual({ value: { turnId: "turn-2" }, cancelled: false });
    expect(stopAfterSetup).not.toHaveBeenCalled();
  });

  it("keeps bounded tombstones so late events cannot settle a replacement turn", () => {
    const retired = new RetiredTurnRegistry(2);
    retired.retire("turn-a");
    retired.retire("turn-b");
    expect(retired.has("turn-a")).toBe(true);
    expect(retired.has("turn-b")).toBe(true);
    expect(retired.has(undefined)).toBe(false);

    retired.retire("turn-c");
    expect(retired.has("turn-a")).toBe(false);
    expect(retired.has("turn-b")).toBe(true);
    expect(retired.has("turn-c")).toBe(true);
  });

  it("gates handshake events until every cancelled owner is retired", () => {
    const pending = new PendingTurnCancellations();
    pending.mark("thread-1", "room-a");
    pending.mark("thread-1", "room-b");
    expect(pending.has("thread-1")).toBe(true);

    pending.clear("thread-1", "room-a");
    expect(pending.has("thread-1")).toBe(true);
    pending.clear("thread-1", "room-b");
    expect(pending.has("thread-1")).toBe(false);
  });
});
