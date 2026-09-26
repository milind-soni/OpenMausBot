import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
