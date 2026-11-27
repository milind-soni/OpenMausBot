import { describe, expect, it } from "vitest";

import { LocalVmLeasePool } from "./local-vm-lease.ts";
import { LocalVmSeatPool } from "./local-vm-seat-pool.ts";

/** Wires the seat chooser to per-seat leases as server/index.ts does, on one virtual clock. */
function harness(seatCount: () => number) {
  const now = { value: 1_000 };
  const leases = new LocalVmLeasePool(100);
  const busy = () => true;
  const seats = new LocalVmSeatPool(seatCount, 30 * 60_000, () => now.value);
  const holderOf = (seat: number) => leases.forTarget("pool:" + seat).current(busy, now.value);
  const claim = (threadId: string, botId: string) => {
    const seat = seats.assign(threadId, holderOf);
    const granted = leases.forTarget("pool:" + seat).claim(threadId, botId, busy, now.value);
    // Mirror server/index.ts: only a won lease renews pool affinity.
    if (granted) seats.touch(threadId);
    return { seat, granted };
  };
  const release = (seat: number, threadId: string) => {
    leases.forTarget("pool:" + seat).release(threadId);
    // Mirror server/index.ts settlement: renew with the seat the turn ran on.
    seats.renew(threadId, seat);
  };
  return { now, seats, leases, busy, claim, release, holderOf };
}

describe("LocalVmSeatPool", () => {
  it("grants two concurrent threads different seats and makes a third wait", () => {
    const { claim, release } = harness(() => 2);

    const first = claim("thread-a", "bot-a");
    const second = claim("thread-b", "bot-b");
    expect(first.granted).toBe(true);
    expect(second.granted).toBe(true);
    expect(second.seat).not.toBe(first.seat);

    const third = claim("thread-c", "bot-c");
    expect(third.granted).toBe(false);
    expect([first.seat, second.seat]).toContain(third.seat);

    release(first.seat, "thread-a");
    const retried = claim("thread-c", "bot-c");
    expect(retried.seat).toBe(third.seat);
    expect(retried.granted).toBe(true);
  });

  it("returns a conversation to its previous seat within the TTL", () => {
    const { now, claim, release } = harness(() => 2);

    const first = claim("thread-a", "bot-a");
    release(first.seat, "thread-a");
    now.value += 60_000;

    const again = claim("thread-a", "bot-a");
    expect(again.seat).toBe(first.seat);
    expect(again.granted).toBe(true);
  });

  it("renews the recorded seat after a turn longer than the affinity TTL", () => {
    const { now, claim, release } = harness(() => 2);

    const first = claim("thread-a", "bot-a");
    now.value += 30 * 60_000 + 1;
    release(first.seat, "thread-a");

    const again = claim("thread-a", "bot-a");
    expect(again.seat).toBe(first.seat);
    expect(again.granted).toBe(true);
  });

  it("prefers a seat with no other live affinity before reusing one", () => {
    const { claim, release } = harness(() => 2);

    const first = claim("thread-a", "bot-a");
    release(first.seat, "thread-a");

    const second = claim("thread-b", "bot-b");
    expect(second.seat).not.toBe(first.seat);
    expect(second.granted).toBe(true);
  });

  it("keeps affinity with a held seat rather than migrating logins", () => {
    const { claim, release, leases, busy, now } = harness(() => 2);

    const first = claim("thread-a", "bot-a");
    release(first.seat, "thread-a");
    // A stranger takes the seat's lease with no recorded affinity, as after a restart that lost the affinity table.
    expect(leases.forTarget("pool:" + first.seat).claim("thread-x", "bot-x", busy, now.value)).toBe(true);

    const again = claim("thread-a", "bot-a");
    expect(again.seat).toBe(first.seat);
    expect(again.granted).toBe(false);
  });

  it("stops renewing affinity while claims keep failing behind a stranger", () => {
    const { now, claim, release, leases, busy } = harness(() => 2);

    const first = claim("thread-a", "bot-a");
    release(first.seat, "thread-a");
    expect(leases.forTarget("pool:" + first.seat).claim("thread-x", "bot-x", busy, now.value)).toBe(true);

    const held = claim("thread-a", "bot-a");
    expect(held.seat).toBe(first.seat);
    expect(held.granted).toBe(false);
    now.value += 30 * 60_000 + 1;
    expect(leases.forTarget("pool:" + first.seat).claim("thread-x", "bot-x", busy, now.value)).toBe(true);
    const migrated = claim("thread-a", "bot-a");
    expect(migrated.seat).not.toBe(first.seat);
    expect(migrated.granted).toBe(true);
  });

  it("drops affinity once the TTL lapses", () => {
    const { now, claim, release } = harness(() => 2);

    const first = claim("thread-a", "bot-a");
    release(first.seat, "thread-a");
    now.value += 30 * 60_000 + 1;

    const fresh = claim("thread-b", "bot-b");
    expect(fresh.seat).toBe(first.seat);
    expect(fresh.granted).toBe(true);
  });

  it("keeps a single-seat pool consistent for a waiting thread", () => {
    const { claim, release } = harness(() => 1);

    const first = claim("thread-a", "bot-a");
    expect(first).toEqual({ seat: 0, granted: true });

    const second = claim("thread-b", "bot-b");
    expect(second).toEqual({ seat: 0, granted: false });

    release(0, "thread-a");
    const retried = claim("thread-b", "bot-b");
    expect(retried).toEqual({ seat: 0, granted: true });
  });

  it("forgets affinity for seats a smaller pool no longer has", () => {
    let seatCount = 2;
    const rig = harness(() => seatCount);

    const first = rig.claim("thread-a", "bot-a");
    const second = rig.claim("thread-b", "bot-b");
    expect(second.seat).not.toBe(first.seat);

    seatCount = 1;
    expect(rig.seats.affinitySeat("thread-b")).toBeNull();
    rig.release(first.seat, "thread-a");

    const reshaped = rig.claim("thread-b", "bot-b");
    expect(reshaped.seat).toBe(first.seat);
    expect(reshaped.granted).toBe(true);
  });

  it("reads affinity without recording it", () => {
    const { seats, holderOf } = harness(() => 2);

    expect(seats.affinitySeat("thread-a")).toBeNull();
    seats.assign("thread-a", holderOf);
    expect(seats.affinitySeat("thread-a")).toBe(0);
    seats.forget("thread-a");
    expect(seats.affinitySeat("thread-a")).toBeNull();
  });

  it("reads the candidate seat without recording or renewing affinity", () => {
    const { now, seats, holderOf, claim, release } = harness(() => 2);

    expect(seats.candidate("thread-a", holderOf)).toBe(0);
    expect(seats.affinitySeat("thread-a")).toBeNull();

    const first = claim("thread-a", "bot-a");
    release(first.seat, "thread-a");
    now.value += 30 * 60_000 - 1;
    expect(seats.candidate("thread-a", holderOf)).toBe(first.seat);
    now.value += 2;
    expect(seats.affinitySeat("thread-a")).toBeNull();
  });
});
