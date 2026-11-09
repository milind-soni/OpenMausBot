import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ComputerControl, type ControlSnapshot } from "./computer-control.ts";

function tracked() {
  const changes: Array<{ botId: string; snapshot: ControlSnapshot }> = [];
  const control = new ComputerControl((botId, snapshot) => changes.push({ botId, snapshot }));
  return { control, changes };
}

describe("computer control", () => {
  it("starts disengaged for an unknown bot", () => {
    const { control } = tracked();
    expect(control.snapshot("b1")).toEqual({ held: false, helpReason: null, heldSinceMs: null });
  });

  it("take → held; release → disengaged, each broadcast once", () => {
    const { control, changes } = tracked();
    const held = control.take("b1");
    expect(held.held).toBe(true);
    expect(held.heldSinceMs).not.toBeNull();
    expect(control.release("b1").held).toBe(false);
    expect(changes.map((c) => c.snapshot.held)).toEqual([true, false]);
  });

  it("a second take does not reset how long the hold has lasted", () => {
    let clock = 1000;
    const control = new ComputerControl(() => {}, () => clock);
    control.take("b1");
    clock = 5000;
    expect(control.take("b1").heldSinceMs).toBe(1000);
  });

  it("atomically acquires a workspace lease without exposing its id", () => {
    const { control, changes } = tracked();
    const leaseId = "5b6bbbd2-b88b-4c50-a748-ec87f332662f";
    const acquired = control.acquireLease("b1", leaseId);
    expect(acquired).toMatchObject({ owned: true, acquired: true, snapshot: { held: true } });
    expect(acquired.snapshot).not.toHaveProperty("controlLeaseId");
    expect(JSON.stringify(changes)).not.toContain(leaseId);

    const sameLease = control.acquireLease("b1", leaseId);
    expect(sameLease).toMatchObject({ owned: true, acquired: false });
    expect(changes).toHaveLength(1);
  });

  it("does not acquire or release a hold owned by another surface", () => {
    const { control, changes } = tracked();
    control.take("b1");
    const leaseId = "57c7f3ef-e41d-4adf-bbda-0bd25bb03893";

    expect(control.acquireLease("b1", leaseId)).toMatchObject({
      owned: false,
      acquired: false,
      snapshot: { held: true },
    });
    expect(control.releaseLease("b1", leaseId)).toMatchObject({
      released: false,
      snapshot: { held: true },
    });
    expect(changes.map((change) => change.snapshot.held)).toEqual([true]);
  });

  it("conditionally releases only the matching workspace lease", () => {
    const { control, changes } = tracked();
    const owner = "33e62f3a-89d9-4117-b48a-15f7deae3252";
    const other = "ed602995-306f-480a-8817-e8d8c8fe7d90";
    control.acquireLease("b1", owner);

    expect(control.releaseLease("b1", other).released).toBe(false);
    expect(control.snapshot("b1").held).toBe(true);
    expect(control.releaseLease("b1", owner)).toMatchObject({
      released: true,
      snapshot: { held: false },
    });
    expect(changes.map((change) => change.snapshot.held)).toEqual([true, false]);
  });

  const ref = (messageId: string, site = "example.com") => ({ botId: "b1", threadId: "t1", messageId, site, place: "browser" as const });

  it("requestHelp surfaces the plea and its card but never grants control", () => {
    const { control } = tracked();
    const snapshot = control.requestHelp("b1", "  sign in to example.com  ", ref("card-1"));
    expect(snapshot.held).toBe(false);
    expect(snapshot.helpReason).toBe("sign in to example.com");
    expect(snapshot.help).toEqual(ref("card-1"));
  });

  it("an empty reason still names the site", () => {
    const { control } = tracked();
    expect(control.requestHelp("b1", undefined, ref("card-1", "mail.example")).helpReason).toBe("sign in to mail.example");
  });

  it("shows the newest plea, and the older one again once the newer settles", () => {
    const { control } = tracked();
    control.requestHelp("b1", "first", ref("card-1"));
    expect(control.requestHelp("b1", "second", ref("card-2", "other.example")).help?.messageId).toBe("card-2");
    expect(control.settleHelp("card-2")).toEqual(["b1"]);
    expect(control.snapshot("b1")).toMatchObject({ helpReason: "first", help: { messageId: "card-1" } });
  });

  it("a plea whose card no longer waits is neither shown nor listed, and counts again once its card waits again", () => {
    const waiting = new Set(["card-1", "card-2"]);
    const control = new ComputerControl(() => {}, Date.now, (ref) => waiting.has(ref.messageId));
    control.requestHelp("b1", "first", ref("card-1"));
    control.requestHelp("b1", "second", ref("card-2"));
    waiting.delete("card-2");
    expect(control.snapshot("b1")).toMatchObject({ helpReason: "first", help: { messageId: "card-1" } });
    expect(control.pleas("b1").map((plea) => plea.messageId)).toEqual(["card-1"]);
    waiting.delete("card-1");
    expect(control.snapshot("b1")).toEqual({ held: false, helpReason: null, heldSinceMs: null });
    expect(control.pleas("b1")).toEqual([]);
    waiting.add("card-2");
    expect(control.snapshot("b1")).toMatchObject({ helpReason: "second", help: { messageId: "card-2" } });
  });

  it("lists every open plea on a key, oldest first", () => {
    const { control } = tracked();
    control.requestHelp("b1", "first", ref("card-1"));
    control.requestHelp("b1", "second", ref("card-2"));
    control.requestHelp("b2", "elsewhere", ref("card-3"));
    expect(control.pleas("b1").map((plea) => plea.messageId)).toEqual(["card-1", "card-2"]);
    control.settleHelp("card-1");
    expect(control.pleas("b1").map((plea) => plea.messageId)).toEqual(["card-2"]);
    expect(control.pleas("nobody")).toEqual([]);
  });

  it("settles only the card it names, wherever it was raised", () => {
    const { control, changes } = tracked();
    control.requestHelp("b1", "first", ref("card-1"));
    expect(control.settleHelp("some-other-card")).toEqual([]);
    expect(changes).toHaveLength(1);
    expect(control.settleHelp("card-1")).toEqual(["b1"]);
    expect(control.snapshot("b1")).toEqual({ held: false, helpReason: null, heldSinceMs: null });
    expect(changes).toHaveLength(2);
  });

  it("a novel-length reason is cut to card size", () => {
    const { control } = tracked();
    const reason = "x".repeat(2000);
    expect(control.requestHelp("b1", reason, ref("card-1")).helpReason?.length).toBe(280);
  });

  it("handing back mid-way keeps the plea: only the card settles it", () => {
    const { control } = tracked();
    control.requestHelp("b1", "sign in to example.com", ref("card-1"));
    control.take("b1");
    const after = control.release("b1");
    expect(after).toMatchObject({ held: false, helpReason: "sign in to example.com", help: { messageId: "card-1" } });
    control.settleHelp("card-1");
    expect(control.snapshot("b1")).toEqual({ held: false, helpReason: null, heldSinceMs: null });
  });

  it("settling a plea while driving keeps the hold", () => {
    const { control } = tracked();
    control.take("b1");
    control.requestHelp("b1", "also this", ref("card-1"));
    control.settleHelp("card-1");
    expect(control.snapshot("b1")).toMatchObject({ held: true, helpReason: null });
  });

  it("bots are independent", () => {
    const { control } = tracked();
    control.take("b1");
    expect(control.snapshot("b2").held).toBe(false);
  });

  it("reports whether a lease holds the computer without taking a free one", () => {
    const control = new ComputerControl();
    expect(control.ownsLease("bot", "lease-aaaaaaaaaaaaaa")).toBe(false);
    expect(control.snapshot("bot").held).toBe(false);
    control.acquireLease("bot", "lease-aaaaaaaaaaaaaa");
    expect(control.ownsLease("bot", "lease-aaaaaaaaaaaaaa")).toBe(true);
    expect(control.ownsLease("bot", "lease-bbbbbbbbbbbbbb")).toBe(false);
    control.release("bot");
    expect(control.ownsLease("bot", "lease-aaaaaaaaaaaaaa")).toBe(false);
  });

  describe("lease expiry", () => {
    const lease = "6f1d2c4e-0b7a-4d58-9a3e-2c1f8e7b5a90";
    const other = "a2b9c7d1-5e3f-4a6b-8c0d-1e2f3a4b5c6d";
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it("a beaten hold is released 60 s after the beat, keeping the plea and broadcasting", () => {
      const { control, changes } = tracked();
      control.requestHelp("b1", "sign in to example.com", ref("card-1"));
      control.acquireLease("b1", lease);
      expect(control.beat("b1", lease)).toBe(true);
      vi.advanceTimersByTime(59_999);
      expect(control.snapshot("b1").held).toBe(true);
      const before = changes.length;
      vi.advanceTimersByTime(2);
      expect(control.snapshot("b1")).toMatchObject({ held: false, help: { messageId: "card-1" } });
      expect(changes.slice(before)).toEqual([{ botId: "b1", snapshot: control.snapshot("b1") }]);
    });

    it("a second beat restarts the 60 s", () => {
      const { control } = tracked();
      control.acquireLease("b1", lease);
      control.beat("b1", lease);
      vi.advanceTimersByTime(30_000);
      control.beat("b1", lease);
      vi.advanceTimersByTime(59_999);
      expect(control.snapshot("b1").held).toBe(true);
      vi.advanceTimersByTime(2);
      expect(control.snapshot("b1").held).toBe(false);
    });

    it("a beat with another lease is refused and does not renew", () => {
      const { control } = tracked();
      control.acquireLease("b1", lease);
      control.beat("b1", lease);
      vi.advanceTimersByTime(30_000);
      expect(control.beat("b1", other)).toBe(false);
      expect(control.beat("b2", lease)).toBe(false);
      vi.advanceTimersByTime(30_001);
      expect(control.snapshot("b1").held).toBe(false);
    });

    it.each([
      ["a fresh armed acquire", (control: ComputerControl) => control.acquireLease("b1", lease, { armed: true })],
      ["an armed acquire of a lease already held", (control: ComputerControl) => {
        control.acquireLease("b1", lease);
        return control.acquireLease("b1", lease, { armed: true });
      }],
    ])("%s with no beat expires at 60 s", (_name, acquire) => {
      const { control } = tracked();
      expect(acquire(control)).toMatchObject({ owned: true, snapshot: { held: true } });
      vi.advanceTimersByTime(59_999);
      expect(control.snapshot("b1").held).toBe(true);
      vi.advanceTimersByTime(2);
      expect(control.snapshot("b1").held).toBe(false);
    });

    it("an unarmed take or acquire that never beats is still held after 2 h", () => {
      const { control } = tracked();
      control.take("b1");
      control.acquireLease("b2", lease);
      vi.advanceTimersByTime(2 * 60 * 60_000);
      expect(control.snapshot("b1").held).toBe(true);
      expect(control.snapshot("b2").held).toBe(true);
    });

    it.each([
      ["releaseLease", (control: ComputerControl) => control.releaseLease("b1", lease)],
      ["release", (control: ComputerControl) => control.release("b1")],
    ])("dropping a beaten hold by %s stops its clock", (_name, drop) => {
      const { control } = tracked();
      control.acquireLease("b1", lease);
      control.beat("b1", lease);
      vi.advanceTimersByTime(30_000);
      drop(control);
      control.acquireLease("b1", lease);
      vi.advanceTimersByTime(2 * 60 * 60_000);
      expect(control.snapshot("b1").held).toBe(true);
    });
  });

  it("forgetBot removes only that bot's pleas, from every key", () => {
    const { control, changes } = tracked();
    const plea = (botId: string, messageId: string) => ({ botId, threadId: "t1", messageId, site: "example.com", place: "browser" as const });
    control.requestHelp("desk", "a asks", plea("a", "a-1"));
    control.requestHelp("desk", "b asks", plea("b", "b-1"));
    control.requestHelp("desk", "a asks again", plea("a", "a-2"));
    control.requestHelp("a", "a asks", plea("a", "a-3"));
    control.take("held");
    control.requestHelp("held", "a asks", plea("a", "a-4"));
    control.requestHelp("b", "b asks", plea("b", "b-2"));
    changes.length = 0;

    control.forgetBot("a");

    expect(control.snapshot("desk")).toEqual({ held: false, helpReason: "b asks", heldSinceMs: null, help: plea("b", "b-1") });
    expect(control.snapshot("a")).toEqual({ held: false, helpReason: null, heldSinceMs: null });
    expect(control.snapshot("held")).toMatchObject({ held: true, helpReason: null });
    expect(control.snapshot("b")).toMatchObject({ helpReason: "b asks", help: { messageId: "b-2" } });
    expect(control.settleHelp("a-1")).toEqual([]);
    expect(changes.map((change) => change.botId).sort()).toEqual(["a", "desk", "held"]);
  });
});
