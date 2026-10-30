import { describe, expect, it } from "vitest";
import { TurnResources, type TurnOwner } from "./turn-resources.ts";

const a = { threadId: "a", generation: "1" };
const b = { threadId: "b", generation: "2" };

describe("thread resource ownership", () => {
  it("allows independent resources but holds the same screen across calls", () => {
    const leases = new TurnResources();
    expect(leases.claim("computer:host", a)).toBe(true);
    expect(leases.claim("computer:host", a)).toBe(true);
    expect(leases.claim("computer:host", b)).toBe(false);
    expect(leases.blocker("computer:host", b)).toEqual(a);
    expect(leases.blocker("computer:host", a)).toBeUndefined();
    expect(leases.claim("browser:other", b)).toBe(true);
    expect(leases.free("computer:host")).toBe(false);
    leases.release(a);
    expect(leases.free("computer:host")).toBe(true);
    expect(leases.blocker("computer:host", b)).toBeUndefined();
    expect(leases.claim("computer:host", b)).toBe(true);
    leases.release(a);
    expect(leases.owns("computer:host", b)).toBe(true);
  });

  it("names the turn holding a resource, and nobody once it is released", () => {
    const leases = new TurnResources();
    expect(leases.holder("browser:one")).toBeUndefined();
    leases.claim("browser:one", a);
    expect(leases.holder("browser:one")).toEqual(a);
    leases.release(a);
    expect(leases.holder("browser:one")).toBeUndefined();
  });

  it("does not release a replacement generation", () => {
    const leases = new TurnResources();
    const next = { ...a, generation: "next" };
    expect(leases.claim("browser:one", a)).toBe(true);
    expect(leases.claim("browser:one", next)).toBe(false);
    leases.release(a);
    expect(leases.claim("browser:one", next)).toBe(true);
    leases.release(a);
    expect(leases.owns("browser:one", next)).toBe(true);
  });

  it("releases one resource early without dropping the owner's others", () => {
    const leases = new TurnResources();
    expect(leases.claim("computer:vm:shared", a)).toBe(true);
    expect(leases.claim("browser:one", a)).toBe(true);
    leases.releaseOne("computer:vm:shared", a);
    expect(leases.owns("computer:vm:shared", a)).toBe(false);
    expect(leases.claim("computer:vm:shared", b)).toBe(true);
    expect(leases.owns("browser:one", a)).toBe(true);
    leases.releaseOne("computer:vm:shared", { ...b, generation: "stale" });
    expect(leases.owns("computer:vm:shared", b)).toBe(true);
  });

  it("onClaim fires when a turn becomes a resource's holder, not when it claims again", () => {
    const leases = new TurnResources();
    const seen: Array<[string, TurnOwner]> = [];
    const stop = leases.onClaim((resource, owner) => { seen.push([resource, owner]); });
    expect(leases.claim("browser:one", a)).toBe(true);
    expect(leases.claim("browser:one", a)).toBe(true);
    expect(leases.claim("browser:one", b)).toBe(false);
    leases.release(a);
    expect(leases.claim("browser:one", b)).toBe(true);
    stop();
    leases.release(b);
    expect(leases.claim("browser:one", a)).toBe(true);
    expect(seen).toEqual([["browser:one", a], ["browser:one", b]]);
  });
});

describe("computer wait queue", () => {
  it("grants a released seat to position 1 in arrival order", () => {
    const leases = new TurnResources();
    const first = { threadId: "w1", generation: "1" };
    const second = { threadId: "w2", generation: "2" };
    const third = { threadId: "w3", generation: "3" };
    expect(leases.claim("computer:host", a)).toBe(true);
    expect(leases.claim("computer:host", first)).toBe(false);
    expect(leases.startWaiting("computer:host", first)).toBe(1);
    expect(leases.claim("computer:host", second)).toBe(false);
    expect(leases.startWaiting("computer:host", second)).toBe(2);
    expect(leases.claim("computer:host", third)).toBe(false);
    expect(leases.startWaiting("computer:host", third)).toBe(3);
    expect(leases.waitPosition("computer:host", second)).toBe(2);
    expect(leases.startWaiting("computer:host", second)).toBe(2);
    leases.release(a);
    expect(leases.claim("computer:host", second)).toBe(false);
    expect(leases.claim("computer:host", third)).toBe(false);
    expect(leases.claim("computer:host", first)).toBe(true);
    expect(leases.waitPosition("computer:host", first)).toBeUndefined();
    expect(leases.waitPosition("computer:host", second)).toBe(1);
    leases.release(first);
    expect(leases.claim("computer:host", third)).toBe(false);
    leases.stopWaiting("computer:host", second);
    expect(leases.claim("computer:host", third)).toBe(true);
  });

  it("lets a lazy claim that never waits jump no queue", () => {
    const leases = new TurnResources();
    const lazy = { threadId: "lazy", generation: "1" };
    const waiting = { threadId: "waiting", generation: "2" };
    expect(leases.claim("computer:host", a)).toBe(true);
    expect(leases.claim("computer:host", lazy)).toBe(false);
    expect(leases.claim("computer:host", waiting)).toBe(false);
    expect(leases.startWaiting("computer:host", waiting)).toBe(1);
    leases.release(a);
    expect(leases.claim("computer:host", lazy)).toBe(false);
    expect(leases.claim("computer:host", waiting)).toBe(true);
    leases.release(waiting);
    leases.startWaiting("computer:host", lazy);
    leases.release(lazy);
    expect(leases.claim("computer:host", b)).toBe(true);
  });

  it("keeps granting the holder's re-claim behind a waitlist", () => {
    const leases = new TurnResources();
    const waiter = { threadId: "w1", generation: "1" };
    expect(leases.claim("computer:host", a)).toBe(true);
    expect(leases.claim("computer:host", waiter)).toBe(false);
    expect(leases.startWaiting("computer:host", waiter)).toBe(1);
    expect(leases.claim("computer:host", a)).toBe(true);
    expect(leases.owns("computer:host", a)).toBe(true);
    expect(leases.waitPosition("computer:host", waiter)).toBe(1);
    leases.release(a);
    expect(leases.claim("computer:host", waiter)).toBe(true);
  });
});

describe("wait estimate history", () => {
  it("shows no estimate until a wait completes, then smooths recent waits", () => {
    const leases = new TurnResources();
    expect(leases.waitEstimateMs("computer:host")).toBeUndefined();
    leases.noteWait("computer:host", 8_000);
    expect(leases.waitEstimateMs("computer:host")).toBe(8_000);
    leases.noteWait("computer:host", 32_000);
    expect(leases.waitEstimateMs("computer:host")).toBe(14_000);
    leases.noteWait("computer:host", Number.NaN);
    leases.noteWait("computer:host", -1);
    expect(leases.waitEstimateMs("computer:host")).toBe(14_000);
    expect(leases.waitEstimateMs("computer:vm:other")).toBeUndefined();
  });
});
