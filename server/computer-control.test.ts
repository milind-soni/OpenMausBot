// The who-is-driving record. What these tests pin is the authority split:
// the person's three moves (take, release, dismiss) all work, the bot's one
// move (requestHelp) never grants anything, and a release settles the help
// request in the same change the person made.
import { describe, expect, it } from "vitest";

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

  it("requestHelp surfaces the plea but never grants control", () => {
    const { control } = tracked();
    const snapshot = control.requestHelp("b1", "  please log in for me  ");
    expect(snapshot.held).toBe(false);
    expect(snapshot.helpReason).toBe("please log in for me");
  });

  it("an empty reason still reads as a plea", () => {
    const { control } = tracked();
    expect(control.requestHelp("b1", undefined).helpReason).toBe("the bot asked you to take over");
  });

  it("a shouted second reason cannot clobber the one the person is reading", () => {
    const { control } = tracked();
    control.requestHelp("b1", "first");
    expect(control.requestHelp("b1", "second").helpReason).toBe("first");
  });

  it("expires only the help request that owns the timeout", () => {
    const { control, changes } = tracked();
    const first = control.requestHelpLease("b1", "first");
    expect(control.expireHelp("b1", "some-older-request").helpReason).toBe("first");
    expect(changes).toHaveLength(1);
    expect(control.expireHelp("b1", first.requestId).helpReason).toBeNull();
    expect(changes).toHaveLength(2);
  });

  it("an old timeout cannot dismiss a newer plea", () => {
    const { control } = tracked();
    const first = control.requestHelpLease("b1", "first");
    control.dismissHelp("b1");
    const second = control.requestHelpLease("b1", "second");
    expect(second.requestId).not.toBe(first.requestId);
    expect(control.expireHelp("b1", first.requestId).helpReason).toBe("second");
  });

  it("a novel-length reason is cut to card size", () => {
    const { control } = tracked();
    const reason = "x".repeat(2000);
    expect(control.requestHelp("b1", reason).helpReason?.length).toBe(280);
  });

  it("release settles an open help request in the same change", () => {
    const { control } = tracked();
    control.requestHelp("b1", "stuck on a captcha");
    control.take("b1");
    const after = control.release("b1");
    expect(after).toEqual({ held: false, helpReason: null, heldSinceMs: null });
  });

  it("dismiss clears the plea without taking control", () => {
    const { control } = tracked();
    control.requestHelp("b1", "stuck");
    const after = control.dismissHelp("b1");
    expect(after.helpReason).toBeNull();
    expect(after.held).toBe(false);
  });

  it("dismiss while driving keeps the hold", () => {
    const { control } = tracked();
    control.take("b1");
    control.requestHelp("b1", "also this");
    const after = control.dismissHelp("b1");
    expect(after.held).toBe(true);
    expect(after.helpReason).toBeNull();
  });

  it("dismissing nothing is silent — no phantom broadcast", () => {
    const { control, changes } = tracked();
    control.dismissHelp("b1");
    expect(changes).toEqual([]);
  });

  it("bots are independent", () => {
    const { control } = tracked();
    control.take("b1");
    expect(control.snapshot("b2").held).toBe(false);
  });

  it("forget clears a hold and tells the listeners", () => {
    const { control, changes } = tracked();
    control.take("b1");
    control.forget("b1");
    expect(control.snapshot("b1").held).toBe(false);
    expect(changes.at(-1)?.snapshot).toEqual({ held: false, helpReason: null, heldSinceMs: null });
  });

  it("forgetting an unknown bot is silent", () => {
    const { control, changes } = tracked();
    control.forget("ghost");
    expect(changes).toEqual([]);
  });
});
