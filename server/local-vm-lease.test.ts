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
});
