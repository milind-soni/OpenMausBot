import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IdleReleasePolicy } from "./claim-idle.ts";
import { computerClaimIdleReleaseEnabled, type AppConfig } from "./config.ts";
import { TurnResources, workspaceResource } from "./turn-resources.ts";

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
    leases.release(a);
    expect(leases.blocker("computer:host", b)).toBeUndefined();
    expect(leases.claim("computer:host", b)).toBe(true);
    leases.release(a);
    expect(leases.owns("computer:host", b)).toBe(true);
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
    // Only the exact owner may drop it: a stale generation is a no-op.
    leases.releaseOne("computer:vm:shared", { ...b, generation: "stale" });
    expect(leases.owns("computer:vm:shared", b)).toBe(true);
  });

  it("prevents parent/child project overlap and symlink aliases, not sibling folders", () => {
    const root = mkdtempSync(join(tmpdir(), "omb-thread-resources-"));
    try {
      mkdirSync(join(root, "project", "nested"), { recursive: true });
      mkdirSync(join(root, "project-other"));
      symlinkSync(join(root, "project"), join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
      const leases = new TurnResources();
      expect(leases.claim(workspaceResource(join(root, "project")), a)).toBe(true);
      expect(leases.claim(workspaceResource(join(root, "alias")), b)).toBe(false);
      expect(leases.claim(workspaceResource(join(root, "project", "nested")), b)).toBe(false);
      expect(leases.claim(workspaceResource(root), b)).toBe(false);
      expect(leases.claim(workspaceResource(join(root, "project-other")), b)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats differently cased paths as one workspace on case-insensitive volumes", ({ skip }) => {
    const root = mkdtempSync(join(tmpdir(), "omb-thread-case-"));
    try {
      const folder = join(root, "Project");
      const alias = join(root, "project");
      mkdirSync(folder);
      if (!existsSync(alias)) return skip();
      expect(workspaceResource(alias)).toBe(workspaceResource(folder));
      const leases = new TurnResources();
      expect(leases.claim(workspaceResource(folder), a)).toBe(true);
      expect(leases.claim(workspaceResource(alias), b)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("computer claim idle release (#1653)", () => {
  const policy = new IdleReleasePolicy(90_000, 600_000);
  const seat = "computer:vm:shared";

  it("releases a quiet seat while the turn lives; the next screen call re-claims with priority", () => {
    const leases = new TurnResources();
    expect(leases.claim(seat, a, { now: 0, idle: policy })).toBe(true);
    // One second short of the window the turn still holds the desktop.
    expect(leases.blocker(seat, b, 89_999)).toEqual(a);
    // Past the quiet window the seat is free for a waiting turn — while
    // the original turn is still live (never released, never settled).
    expect(leases.blocker(seat, b, 90_000)).toBeUndefined();
    expect(leases.owns(seat, a, 90_000)).toBe(false);
    expect(leases.claim(seat, b, { now: 90_000, idle: policy })).toBe(true);
    leases.release(b);
    // Inside the reclaim window the previous holder's next screen call
    // takes the free seat straight back: no wait, no queue.
    expect(leases.claim(seat, a, { now: 95_000, idle: policy })).toBe(true);
    expect(leases.owns(seat, a, 95_000)).toBe(true);
  });

  it("screen activity resets the quiet window", () => {
    const leases = new TurnResources();
    expect(leases.claim(seat, a, { now: 0, idle: policy })).toBe(true);
    leases.activity(seat, a, 60_000);
    expect(leases.blocker(seat, b, 120_000)).toEqual(a); // 60s quiet, not 120
    // One tick short of the boundary the call is real activity and resets
    // the window; at the boundary it is a straggler and must not.
    leases.activity(seat, a, 149_999);
    expect(leases.blocker(seat, b, 239_998)).toEqual(a);
    expect(leases.blocker(seat, b, 239_999)).toBeUndefined();
  });

  it("a late completion does not resurrect an expired claim", () => {
    const leases = new TurnResources();
    expect(leases.claim(seat, a, { now: 0, idle: policy })).toBe(true);
    leases.activity(seat, a, 60_000);
    // Exactly 90s quiet: the seat is gone, and a straggler completion
    // arriving now opens the reclaim window instead of holding the seat.
    expect(leases.owns(seat, a, 150_000)).toBe(false);
    leases.activity(seat, a, 150_000);
    expect(leases.blocker(seat, b, 150_001)).toBeUndefined();
    expect(leases.reclaimHolder(seat, 150_000)).toEqual(a);
  });

  it("a repeated claim by the sitting owner keeps the quiet window", () => {
    const leases = new TurnResources();
    expect(leases.claim(seat, a, { now: 0, idle: policy })).toBe(true);
    leases.activity(seat, a, 60_000);
    expect(leases.claim(seat, a, { now: 120_000, idle: policy })).toBe(true);
    // The re-claim did not restart activityAt: 90s from the last real
    // screen call still releases the seat.
    expect(leases.blocker(seat, b, 149_999)).toEqual(a);
    expect(leases.blocker(seat, b, 150_000)).toBeUndefined();
  });

  it("an early releaseOne keeps no reclaim priority, even at the deadline", () => {
    const leases = new TurnResources();
    expect(leases.claim(seat, a, { now: 0, idle: policy })).toBe(true);
    leases.activity(seat, a, 60_000);
    // At the quiet boundary owns() expires the claim into a reclaim
    // record; releaseOne must clear that priority too, not just the seat.
    leases.releaseOne(seat, a, 150_000);
    expect(leases.reclaimHolder(seat, 150_000)).toBeUndefined();
  });

  it("releases with no screen activity — poller frames never count", () => {
    const leases = new TurnResources();
    expect(leases.claim(seat, a, { now: 0, idle: policy })).toBe(true);
    // No activity() call between claim and now: silence, however many
    // preview frames the poller took, is still silence.
    expect(leases.blocker(seat, b, 150_000)).toBeUndefined();
    expect(leases.owns(seat, a, 150_000)).toBe(false);
  });

  it("an in-flight computer call fences the seat past the quiet window", () => {
    const leases = new TurnResources();
    expect(leases.claim(seat, a, { now: 0, idle: policy })).toBe(true);
    leases.beginComputerCall(seat, a);
    // The call outruns the quiet window: no mid-call handoff, ever.
    expect(leases.blocker(seat, b, 10_000_000)).toEqual(a);
    expect(leases.owns(seat, a, 10_000_000)).toBe(true);
    // A stale end from another owner never lifts the sitting owner's fence.
    leases.endComputerCall(seat, b);
    expect(leases.blocker(seat, b, 10_000_001)).toEqual(a);
  });

  it("completing the in-flight call releases the fence, then the seat", () => {
    const leases = new TurnResources();
    expect(leases.claim(seat, a, { now: 0, idle: policy })).toBe(true);
    leases.beginComputerCall(seat, a);
    leases.endComputerCall(seat, a);
    leases.activity(seat, a, 91_000);
    // The call outran the window: its completion releases the seat (no
    // straggler restart) and opens the reclaim window for the holder.
    expect(leases.owns(seat, a, 91_000)).toBe(false);
    expect(leases.reclaimHolder(seat, 91_000)).toEqual(a);
    expect(leases.claim(seat, b, { now: 91_000, idle: policy })).toBe(true);
  });

  it("a call inside the window keeps the normal quiet clock", () => {
    const leases = new TurnResources();
    expect(leases.claim(seat, a, { now: 0, idle: policy })).toBe(true);
    leases.beginComputerCall(seat, a);
    leases.endComputerCall(seat, a);
    leases.activity(seat, a, 60_000);
    expect(leases.blocker(seat, b, 149_999)).toEqual(a);
    expect(leases.blocker(seat, b, 150_000)).toBeUndefined();
  });

  it("yields to an occupied seat and ends the previous holder's priority", () => {
    const leases = new TurnResources();
    expect(leases.claim(seat, a, { now: 0, idle: policy })).toBe(true);
    expect(leases.blocker(seat, b, 91_000)).toBeUndefined(); // idle release
    expect(leases.reclaimHolder(seat, 91_000)).toEqual(a);
    // Another turn seats itself: the previous holder no longer re-claims
    // directly, and its claim is refused like any newcomer's.
    expect(leases.claim(seat, b, { now: 92_000, idle: policy })).toBe(true);
    expect(leases.reclaimHolder(seat, 95_000)).toBeUndefined();
    expect(leases.claim(seat, a, { now: 95_000 })).toBe(false);
    expect(leases.blocker(seat, a, 95_000)).toEqual(b);
  });

  it("ends reclaim priority with the window and at turn settle", () => {
    const leases = new TurnResources();
    expect(leases.claim(seat, a, { now: 0, idle: policy })).toBe(true);
    expect(leases.blocker(seat, b, 91_000)).toBeUndefined();
    expect(leases.reclaimHolder(seat, 91_000 + 600_000 - 1)).toEqual(a);
    expect(leases.reclaimHolder(seat, 91_000 + 600_000)).toBeUndefined();

    expect(leases.claim(seat, a, { now: 0, idle: policy })).toBe(true);
    expect(leases.blocker(seat, b, 91_000)).toBeUndefined();
    // A turn that settles keeps no priority: only a live mid-task turn
    // may pick its seat back up.
    leases.release(a);
    expect(leases.reclaimHolder(seat, 92_000)).toBeUndefined();
  });

  it("leaves claims without an idle policy held until settle", () => {
    const leases = new TurnResources();
    expect(leases.claim(seat, a, { now: 0 })).toBe(true);
    expect(leases.claim("browser:one", a, { now: 0 })).toBe(true);
    expect(leases.blocker(seat, b, 10_000_000)).toEqual(a);
    expect(leases.blocker("browser:one", b, 10_000_000)).toEqual(a);
    expect(leases.activity(seat, a, 10_000_000)).toBeUndefined();
  });

  it("ships disabled by default (#1653 config gate)", () => {
    expect(computerClaimIdleReleaseEnabled({} as AppConfig)).toBe(false);
    expect(computerClaimIdleReleaseEnabled({ features: { computerClaimIdleRelease: false } } as AppConfig)).toBe(false);
    expect(computerClaimIdleReleaseEnabled({ features: { computerClaimIdleRelease: true } } as AppConfig)).toBe(true);
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
    // Rejoining keeps the original place: positions never jitter.
    expect(leases.startWaiting("computer:host", second)).toBe(2);
    leases.release(a);
    // The seat is free but reserved for position 1: the claim-poll race
    // cannot let a later waiter jump the queue (#1652).
    expect(leases.claim("computer:host", second)).toBe(false);
    expect(leases.claim("computer:host", third)).toBe(false);
    expect(leases.claim("computer:host", first)).toBe(true);
    expect(leases.waitPosition("computer:host", first)).toBeUndefined();
    expect(leases.waitPosition("computer:host", second)).toBe(1);
    leases.release(first);
    // A waiter that stops waiting frees its place for the ones behind.
    expect(leases.claim("computer:host", third)).toBe(false);
    leases.stopWaiting("computer:host", second);
    expect(leases.claim("computer:host", third)).toBe(true);
  });

  it("lets a lazy claim that never waits jump no queue", () => {
    const leases = new TurnResources();
    const lazy = { threadId: "lazy", generation: "1" };
    const waiting = { threadId: "waiting", generation: "2" };
    expect(leases.claim("computer:host", a)).toBe(true);
    // A lazy claim fails once and moves on without joining the waitlist...
    expect(leases.claim("computer:host", lazy)).toBe(false);
    expect(leases.claim("computer:host", waiting)).toBe(false);
    expect(leases.startWaiting("computer:host", waiting)).toBe(1);
    leases.release(a);
    // ...so it cannot take the seat out from under an actively waiting turn.
    expect(leases.claim("computer:host", lazy)).toBe(false);
    expect(leases.claim("computer:host", waiting)).toBe(true);
    leases.release(waiting);
    // Turn settle sweeps any leftover waitlist entry for the owner.
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
    // Every screen tools/call re-validates the claim: the legitimate
    // holder must keep its grant even once a waiter queues behind it.
    expect(leases.claim("computer:host", a)).toBe(true);
    expect(leases.owns("computer:host", a)).toBe(true);
    // FIFO is intact: the waiter keeps position 1 and the next seat.
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
    // Weight 1/4: the newest wait moves the estimate a quarter of the way.
    expect(leases.waitEstimateMs("computer:host")).toBe(14_000);
    // Junk samples never poison the average, and history stays per resource.
    leases.noteWait("computer:host", Number.NaN);
    leases.noteWait("computer:host", -1);
    expect(leases.waitEstimateMs("computer:host")).toBe(14_000);
    expect(leases.waitEstimateMs("computer:vm:other")).toBeUndefined();
  });
});

describe("parked-resume idle availability", () => {
  const policy = new IdleReleasePolicy(90_000, 600_000);
  const seat = "computer:vm:shared";
  it("free() expires an elapsed quiet claim instead of reporting the seat busy", () => {
    const leases = new TurnResources();
    expect(leases.claim(seat, a, { now: 0, idle: policy })).toBe(true);
    // Inside the window the parked-resume gate still sees the seat held.
    expect(leases.free(seat, 89_999)).toBe(false);
    // Past the quiet window the gate must see the seat free on its own,
    // without another operation touching the claim first — and the
    // previous holder keeps its reclaim priority.
    expect(leases.free(seat, 90_000)).toBe(true);
    expect(leases.claim(seat, b, { now: 90_000, idle: policy })).toBe(true);
    leases.release(b);
    expect(leases.claim(seat, a, { now: 95_000, idle: policy })).toBe(true);
  });
});
