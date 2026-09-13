import { describe, expect, it, vi } from "vitest";

import {
  PendingTurnCancellations,
  ProviderTurnGenerationRegistry,
  RetiredTurnRegistry,
  guardTurnDispatch,
  isTurnAdmissionBlocked,
  isTurnEventQuarantined,
} from "./turn-dispatch-guard.ts";

describe("retryable turn admission", () => {
  it("recognizes busy and capacity codes independently of their wording", () => {
    for (const code of ["thread_busy", "thread_limit"]) {
      expect(isTurnAdmissionBlocked(Object.assign(new Error("The admission message changed"), { status: 409, code }))).toBe(true);
      expect(isTurnAdmissionBlocked({ code })).toBe(true);
    }
  });

  it("does not retry other failures just because they mention working", () => {
    for (const error of [
      new Error("already working but the provider is unavailable"),
      Object.assign(new Error("already working"), { status: 409, code: "workspace_busy" }),
      { status: 409 }, { code: "provider_unavailable" }, null, undefined, "thread_limit",
    ]) {
      expect(isTurnAdmissionBlocked(error)).toBe(false);
    }
  });
});

describe("provider turn capability correlation", () => {
  it("rejects a bind when completion arrived before sendTurn resolved", () => {
    const turns = new ProviderTurnGenerationRegistry();
    expect(turns.complete("thread-1", "turn-1")).toBeNull();
    expect(turns.bind("thread-1", "generation-1", "turn-1")).toBe(false);
  });

  it("returns the exact owner when completion follows a normal bind", () => {
    const turns = new ProviderTurnGenerationRegistry();
    expect(turns.bind("thread-1", "generation-1", "turn-1")).toBe(true);
    expect(turns.complete("thread-1", "turn-1")).toEqual({
      threadId: "thread-1",
      generation: "generation-1",
    });
  });

  it("retains an early result only for its exact thread and provider ACK", () => {
    const turns = new ProviderTurnGenerationRegistry<{ ok: boolean; text: string }>();
    const outcome = { ok: true, text: "Reviewer ran the tests" };
    expect(turns.complete("thread-1", "fast-turn", outcome)).toBeNull();
    expect(turns.takeEarlyCompletion("other-thread", "fast-turn")).toBeUndefined();
    expect(turns.bind("thread-1", "new-generation", "new-turn")).toBe(true);
    expect(turns.takeEarlyCompletion("thread-1", "new-turn")).toBeUndefined();
    expect(turns.bind("thread-1", "fast-generation", "fast-turn")).toBe(false);
    expect(turns.takeEarlyCompletion("thread-1", "fast-turn")).toEqual(outcome);
    expect(turns.takeEarlyCompletion("thread-1", "fast-turn")).toBeUndefined();
    expect(turns.complete("thread-1", "fast-turn", { ok: false, text: "duplicate" })).toBeNull();
    expect(turns.takeEarlyCompletion("thread-1", "fast-turn")).toBeUndefined();
    expect(turns.complete("thread-1", "new-turn")).toEqual({ threadId: "thread-1", generation: "new-generation" });
  });

  it("does not let a late completion from a stopped generation settle its replacement", () => {
    const turns = new ProviderTurnGenerationRegistry<string>();
    turns.bind("same-thread", "stopped-generation", "old-turn");
    expect(turns.deleteGeneration("same-thread", "stopped-generation")).toEqual(["old-turn"]);
    turns.bind("same-thread", "replacement-generation", "new-turn");
    expect(turns.complete("same-thread", "old-turn", "stale success")).toBeNull();
    expect(turns.takeEarlyCompletion("same-thread", "old-turn")).toBeUndefined();
    expect(turns.complete("same-thread", "new-turn", "real success")).toEqual({
      threadId: "same-thread", generation: "replacement-generation",
    });
  });

  it("cannot settle another thread or consume its ownership", () => {
    const turns = new ProviderTurnGenerationRegistry();
    turns.bind("owner-thread", "generation", "turn");
    expect(turns.complete("wrong-thread", "turn")).toBeNull();
    expect(turns.complete("owner-thread", "turn")).toEqual({ threadId: "owner-thread", generation: "generation" });
  });

  it("bounds unclaimed early receipts and clears their payloads", () => {
    const turns = new ProviderTurnGenerationRegistry<string>(2);
    turns.complete("thread", "one", "one");
    turns.complete("thread", "two", "two");
    turns.complete("thread", "three", "three");
    expect(turns.takeEarlyCompletion("thread", "one")).toBeUndefined();
    expect(turns.takeEarlyCompletion("thread", "two")).toBe("two");
    turns.clear();
    expect(turns.takeEarlyCompletion("thread", "three")).toBeUndefined();
  });
});

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

  it("expires a hung handshake without admitting turn ids captured while it was pending", () => {
    vi.useFakeTimers();
    try {
      const pending = new PendingTurnCancellations(100);
      const retired = new RetiredTurnRegistry();
      pending.mark("thread-1", "direct-a");

      expect(isTurnEventQuarantined(pending, retired, {
        threadId: "thread-1",
        turnId: "cancelled-turn",
      })).toBe(true);

      vi.advanceTimersByTime(100);
      expect(pending.has("thread-1")).toBe(false);
      expect(isTurnEventQuarantined(pending, retired, {
        threadId: "thread-1",
        turnId: "cancelled-turn",
      })).toBe(true);
      expect(isTurnEventQuarantined(pending, retired, {
        threadId: "thread-1",
        turnId: "replacement-turn",
      })).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let an old expiry callback clear a renewed owner", () => {
    vi.useFakeTimers();
    try {
      const pending = new PendingTurnCancellations(100);
      pending.mark("thread-1", "direct-a");
      vi.advanceTimersByTime(60);
      pending.mark("thread-1", "direct-a");
      vi.advanceTimersByTime(60);
      expect(pending.has("thread-1")).toBe(true);

      vi.advanceTimersByTime(40);
      expect(pending.has("thread-1")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds a replacement until the cancelled handshake quarantine expires", async () => {
    vi.useFakeTimers();
    try {
      const pending = new PendingTurnCancellations(100);
      pending.mark("thread-1", "direct-a");
      let admitted = false;
      const waiting = pending.waitForClear("thread-1").then(() => {
        admitted = true;
      });

      await vi.advanceTimersByTimeAsync(99);
      expect(admitted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await waiting;
      expect(admitted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-checks the gate when a cancellation is renewed as waiters wake", async () => {
    const pending = new PendingTurnCancellations(30_000);
    pending.mark("thread-1", "direct-a");
    let admitted = false;
    const waiting = pending.waitForClear("thread-1").then(() => {
      admitted = true;
    });

    pending.clear("thread-1", "direct-a");
    pending.mark("thread-1", "direct-b");
    await Promise.resolve();
    expect(admitted).toBe(false);

    pending.clear("thread-1", "direct-b");
    await waiting;
    expect(admitted).toBe(true);
  });
});
