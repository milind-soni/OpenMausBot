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
