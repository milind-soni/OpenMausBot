import { describe, expect, it } from "vitest";

import { TurnScheduler } from "./turn-scheduler.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

describe("TurnScheduler", () => {
  it("runs one turn per bot, keeps FIFO inside lanes, and prioritizes humans", async () => {
    const scheduler = new TurnScheduler({ maxPendingPerBot: 8, reservedUserSlots: 0 });
    const first = deferred();
    const order: string[] = [];
    const active = scheduler.admit({ botId: "a", lane: "peer", run: async () => { order.push("active"); await first.promise; } });
    expect(active.accepted && active.admission.queued).toBe(false);
    const normal = scheduler.admit({ botId: "a", lane: "peer", run: async () => { order.push("peer"); } });
    const background = scheduler.admit({ botId: "a", lane: "background", run: async () => { order.push("background"); } });
    const urgent = scheduler.admit({ botId: "a", lane: "urgent-peer", run: async () => { order.push("urgent"); } });
    const user = scheduler.admit({ botId: "a", lane: "user", run: async () => { order.push("user"); } });
    if (!active.accepted || !normal.accepted) throw new Error("expected scheduler admissions");
    first.resolve();
    await Promise.all([
      active.completion,
      normal.completion,
      background.accepted && background.completion,
      urgent.accepted && urgent.completion,
      user.accepted && user.completion,
    ]);
    expect(order).toEqual(["active", "user", "urgent", "peer", "background"]);
  });

  it("allows different bots to run concurrently", async () => {
    const scheduler = new TurnScheduler();
    const a = deferred();
    const b = deferred();
    const seen: string[] = [];
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
    const aAdmission = scheduler.admit({ botId: "a", lane: "user", run: async () => { seen.push("a-start"); if (seen.length === 2) resolveStarted(); await a.promise; seen.push("a-end"); } });
    const bAdmission = scheduler.admit({ botId: "b", lane: "user", run: async () => { seen.push("b-start"); if (seen.length === 2) resolveStarted(); await b.promise; seen.push("b-end"); } });
    await started;
    expect(seen).toEqual(["a-start", "b-start"]);
    a.resolve();
    b.resolve();
    if (aAdmission.accepted && bAdmission.accepted) await Promise.all([aAdmission.completion, bAdmission.completion]);
    expect(seen).toEqual(["a-start", "b-start", "a-end", "b-end"]);
  });

  it("reserves capacity for user work and supports cancellation", async () => {
    const scheduler = new TurnScheduler({ maxPendingPerBot: 3, reservedUserSlots: 1 });
    const hold = deferred();
    scheduler.admit({ botId: "a", lane: "user", run: () => hold.promise });
    const peer = scheduler.admit({ botId: "a", lane: "peer", run: () => {} });
    expect(peer.accepted).toBe(true);
    const remaining = scheduler.admit({ botId: "a", lane: "peer", run: () => {} });
    const rejected = scheduler.admit({ botId: "a", lane: "peer", run: () => {} });
    expect(rejected).toEqual({ accepted: false, reason: "capacity" });
    if (!peer.accepted) throw new Error("expected a queued peer");
    void peer.completion.catch(() => {});
    expect(scheduler.cancel("a", peer.admission.id)).toBe(true);
    expect(scheduler.diagnostics("a").pending).toBe(1);
    hold.resolve();
    if (remaining.accepted) await remaining.completion;
  });

  it("deduplicates queued work and never lets a late release free a newer run", async () => {
    const scheduler = new TurnScheduler();
    const first = deferred();
    const second = deferred();
    const firstAdmission = scheduler.admit({ botId: "a", lane: "user", dedupeKey: "same", run: () => first.promise });
    const duplicate = scheduler.admit({ botId: "a", lane: "peer", dedupeKey: "same", run: () => {} });
    expect(duplicate).toEqual({ accepted: false, reason: "duplicate" });
    first.resolve();
    if (firstAdmission.accepted) await firstAdmission.completion;
    const queued = scheduler.admit({ botId: "a", lane: "user", run: () => second.promise });
    expect(queued.accepted).toBe(true);
    // A stale generation cannot release the new active turn.
    expect(scheduler.release("a", "not-the-current-run")).toBe(false);
    expect(scheduler.hasActive("a")).toBe(true);
    second.resolve();
    if (queued.accepted) await queued.completion;
  });
});
