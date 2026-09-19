import { describe, expect, it } from "vitest";

import { LocalVmLease, LocalVmLeasePool } from "./local-vm-lease.ts";

describe("LocalVmLease", () => {
  it("serializes different threads while letting the owner renew", () => {
    const lease = new LocalVmLease(100);
    const busy = () => true;

    expect(lease.claim("thread-a", "bot-a", busy, 1_000)).toBe(true);
    expect(lease.claim("thread-b", "bot-b", busy, 1_001)).toBe(false);
    expect(lease.claim("thread-a", "bot-a", busy, 1_002)).toBe(true);
    expect(lease.current(busy, 1_050)).toMatchObject({ threadId: "thread-a", botId: "bot-a" });
  });

  it("expires a wedged owner and allows recovery", () => {
    const lease = new LocalVmLease(100);
    const busy = () => true;

    lease.claim("thread-a", "bot-a", busy, 1_000);

    expect(lease.current(busy, 1_100)).toBeNull();
    expect(lease.claim("thread-b", "bot-b", busy, 1_100)).toBe(true);
  });

  it("refreshes on owner activity and releases when its bot settles", () => {
    const lease = new LocalVmLease(100);
    let ownerBusy = true;
    const busy = () => ownerBusy;

    lease.claim("thread-a", "bot-a", busy, 1_000);
    lease.touch("thread-a", 1_090);
    expect(lease.current(busy, 1_150)).not.toBeNull();

    ownerBusy = false;
    expect(lease.current(busy, 1_151)).toBeNull();
  });

  // The screen poller's Local VM capture reads current() to decide whether a
  // frame still belongs to the turn that asked for it: the settled transcript
  // frame is taken AFTER the turn released the desktop, so "nobody owns it"
  // has to stay distinguishable from "somebody else does".
  it("reads as unowned once the turn settles, and as the new thread after a handoff", () => {
    const lease = new LocalVmLease(100);
    let busyBot: string | null = "bot-a";
    const busy = (botId: string) => botId === busyBot;

    lease.claim("thread-a", "bot-a", busy, 1_000);
    busyBot = null;
    expect(lease.current(busy, 1_010)).toBeNull();

    busyBot = "bot-b";
    lease.claim("thread-b", "bot-b", busy, 1_020);
    expect(lease.current(busy, 1_030)).toMatchObject({ threadId: "thread-b" });
  });

  it("does not revive an expired owner from a delayed event", () => {
    const lease = new LocalVmLease(100);
    const busy = () => true;

    lease.claim("thread-a", "bot-a", busy, 1_000);
    lease.touch("thread-a", 1_100);

    expect(lease.current(busy, 1_100)).toBeNull();
    expect(lease.claim("thread-b", "bot-b", busy, 1_100)).toBe(true);
  });

  it("only lets the owning thread release the lease", () => {
    const lease = new LocalVmLease(100);
    const busy = () => true;
    lease.claim("thread-a", "bot-a", busy, 1_000);

    lease.release("thread-b");
    expect(lease.current(busy, 1_001)).not.toBeNull();
    lease.release("thread-a");
    expect(lease.current(busy, 1_002)).toBeNull();
  });

  // Issue #860: a direct turn that loses its terminal event leaves the
  // record untouched while its bot idles, and the next task's claim() finds
  // the owner busy again — the lazy idle clear in current() never runs. The
  // watchdog sweep must therefore release the stale claim by the generation
  // it captured, after which the next task's claim succeeds.
  it("releases a lost-terminal claim by generation so the next task can claim", () => {
    const lease = new LocalVmLease(100);
    const busy = () => true;

    lease.claim("direct-thread", "bot-a", busy, 1_000);
    const stalledGeneration = lease.current(busy, 1_001)!.generation;
    // The owner idles after the lost terminal event but is busy again by
    // the time the next task dispatches, so the lazy idle clear in
    // current() cannot rescue the new thread.
    expect(lease.claim("next-task-thread", "bot-a", busy, 1_050)).toBe(false);

    lease.release("direct-thread", stalledGeneration);
    expect(lease.current(busy, 1_051)).toBeNull();
    expect(lease.claim("next-task-thread", "bot-a", busy, 1_052)).toBe(true);
  });

  // The delayed-callback half of issue #860: a replacement turn re-claims
  // the SAME thread id, so only the stamped generation separates its claim
  // from the superseded turn's late release.
  it("ignores a stale callback that outlives a replacement claim on the same thread", () => {
    const lease = new LocalVmLease(100);
    const busy = () => true;

    lease.claim("direct-thread", "bot-a", busy, 1_000);
    const staleGeneration = lease.current(busy, 1_001)!.generation;
    lease.claim("direct-thread", "bot-a", busy, 1_005);
    const replacement = lease.current(busy, 1_006)!;
    expect(replacement.generation).not.toBe(staleGeneration);

    lease.release("direct-thread", staleGeneration);
    expect(lease.current(busy, 1_007)).toMatchObject({ generation: replacement.generation });

    lease.release("direct-thread", replacement.generation);
    expect(lease.current(busy, 1_008)).toBeNull();
  });

  it("stamps a strictly increasing generation on every claim", () => {
    const lease = new LocalVmLease(100);
    const busy = () => true;

    lease.claim("thread-a", "bot-a", busy, 1_000);
    const first = lease.current(busy, 1_001)!.generation;
    lease.claim("thread-a", "bot-a", busy, 1_002);
    const second = lease.current(busy, 1_003)!.generation;
    expect(second).toBeGreaterThan(first);

    lease.release("thread-a");
    lease.claim("thread-b", "bot-b", busy, 1_004);
    expect(lease.current(busy, 1_005)!.generation).toBeGreaterThan(second);
  });

  // The stall sweep fences on generationOf, not current(): judging a fence
  // must never clear the expired or idle record it is comparing against.
  it("reads a thread's claim generation without resolving liveness", () => {
    const lease = new LocalVmLease(100);
    let ownerBusy = true;
    const busy = () => ownerBusy;

    lease.claim("thread-a", "bot-a", busy, 1_000);
    expect(lease.generationOf("thread-a")).toBe(1);
    expect(lease.generationOf("thread-b")).toBeUndefined();

    ownerBusy = false;
    expect(lease.generationOf("thread-a")).toBe(1);
    expect(lease.current(busy, 1_100)).toBeNull();
    expect(lease.generationOf("thread-a")).toBeUndefined();
  });
});

describe("LocalVmLeasePool", () => {
  it("allows distinct bot targets concurrently while serializing each target", () => {
    const pool = new LocalVmLeasePool(100);
    const busy = () => true;

    expect(pool.forTarget("bot:a").claim("thread-a", "bot-a", busy, 1_000)).toBe(true);
    expect(pool.forTarget("bot:b").claim("thread-b", "bot-b", busy, 1_000)).toBe(true);
    expect(pool.forTarget("bot:a").claim("thread-c", "bot-c", busy, 1_001)).toBe(false);
    expect(pool.forTarget("bot:b").current(busy, 1_002)).toMatchObject({ botId: "bot-b" });
  });

  it("keeps shared mode serialized because every bot resolves to the same target", () => {
    const pool = new LocalVmLeasePool(100);
    const busy = () => true;

    expect(pool.forTarget("shared").claim("thread-a", "bot-a", busy, 1_000)).toBe(true);
    expect(pool.forTarget("shared").claim("thread-b", "bot-b", busy, 1_001)).toBe(false);
  });

  it("forgets a deleted bot's target lane", () => {
    const pool = new LocalVmLeasePool(100);
    const busy = () => true;
    const original = pool.forTarget("bot:deleted");
    expect(original.claim("thread-a", "bot-a", busy, 1_000)).toBe(true);

    pool.forget("bot:deleted");

    const replacement = pool.forTarget("bot:deleted");
    expect(replacement).not.toBe(original);
    expect(replacement.current(busy, 1_001)).toBeNull();
  });
});
