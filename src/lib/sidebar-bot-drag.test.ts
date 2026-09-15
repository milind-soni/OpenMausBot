import { describe, expect, it } from "vitest";

import {
  armBotClickLatch,
  bindLiftedTouchMoveGuard,
  botDropCommits,
  botDropPlace,
  botDropTarget,
  botFloatPosition,
  botLiftNeedsTouchMoveGuard,
  botLongPressShouldCancel,
  botPointerMatches,
  clearBotClickLatch,
  consumeBotClickLatch,
} from "./sidebar-bot-drag";

describe("sidebar bot long-press drag", () => {
  it("cancels a pending lift after the finger moves, not for jitter", () => {
    expect(botLongPressShouldCancel(10, 10, 12, 11)).toBe(false);
    expect(botLongPressShouldCancel(10, 10, 10, 21)).toBe(true);
    expect(botLongPressShouldCancel(0, 0, 6, 6, 10)).toBe(false);
  });

  it("splits a row at its midline", () => {
    expect(botDropPlace(24, 20, 40)).toBe("before");
    expect(botDropPlace(41, 20, 40)).toBe("after");
  });

  it("keeps the floating row under the original grab point", () => {
    expect(botFloatPosition(100, 80, 12, 20)).toEqual({ left: 88, top: 60 });
  });

  it("targets the nearest other row and ignores the lifted one", () => {
    const rows = [
      { id: "waffle", top: 0, height: 40 },
      { id: "finch", top: 44, height: 40 },
      { id: "churro", top: 88, height: 40 },
    ];
    expect(botDropTarget(10, rows, "finch")).toEqual({ id: "waffle", place: "before" });
    expect(botDropTarget(30, rows, "finch")).toEqual({ id: "waffle", place: "after" });
    expect(botDropTarget(100, rows, "finch")).toEqual({ id: "churro", place: "before" });
    expect(botDropTarget(200, rows, "waffle")).toEqual({ id: "churro", place: "after" });
    expect(botDropTarget(70, rows, "waffle")).toEqual({ id: "finch", place: "after" });
    expect(botDropTarget(0, [{ id: "only", top: 0, height: 40 }], "only")).toBeNull();
  });

  it("lets the list pan until lift, then consumes touchmove so the float survives", () => {
    expect(botLiftNeedsTouchMoveGuard(false)).toBe(false);
    expect(botLiftNeedsTouchMoveGuard(true)).toBe(true);

    const target = new EventTarget();
    const unbind = bindLiftedTouchMoveGuard(target);
    const event = new Event("touchmove", { cancelable: true, bubbles: true });
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    unbind();
    const after = new Event("touchmove", { cancelable: true, bubbles: true });
    target.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it("does not persist a drop outside any other row", () => {
    expect(botDropCommits(null)).toBe(false);
    expect(botDropCommits(undefined)).toBe(false);
    expect(botDropCommits({ id: "finch" })).toBe(true);
    expect(botDropTarget(10, [{ id: "waffle", top: 0, height: 40 }], "waffle")).toBeNull();
  });

  it("clears click suppression on the next pointerdown so the same bot can be selected", () => {
    const latch = { suppressed: false };
    armBotClickLatch(latch, false);
    expect(consumeBotClickLatch(latch)).toBe(false);

    armBotClickLatch(latch, true);
    expect(latch.suppressed).toBe(true);
    // leftover click from the drag is swallowed once
    expect(consumeBotClickLatch(latch)).toBe(true);
    expect(latch.suppressed).toBe(false);

    armBotClickLatch(latch, true);
    clearBotClickLatch(latch);
    expect(consumeBotClickLatch(latch)).toBe(false);
  });

  it("ignores pointer events from a second finger during a lift", () => {
    expect(botPointerMatches(7, 7)).toBe(true);
    expect(botPointerMatches(7, 8)).toBe(false);
  });

  it("cancels a pending lift when the finger moves, which is what keeps scrolling", () => {
    expect(botLongPressShouldCancel(0, 0, 0, 11)).toBe(true);
    expect(botLiftNeedsTouchMoveGuard(false)).toBe(false);
  });
});
