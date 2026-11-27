import { describe, expect, it, vi } from "vitest";

import { createConnectedDeviceTracker } from "../src/connected-devices.ts";

describe("connected device tracker", () => {
  it("keeps a device live until every overlapping event stream closes", () => {
    const tracker = createConnectedDeviceTracker();
    const closeOldRoute = tracker.open("phone-1");
    const closeNewRoute = tracker.open("phone-1");
    const closeOtherPhone = tracker.open("phone-2");

    expect(tracker.ids()).toEqual(["phone-1", "phone-2"]);
    closeOldRoute();
    expect(tracker.ids()).toEqual(["phone-1", "phone-2"]);
    closeNewRoute();
    expect(tracker.ids()).toEqual(["phone-2"]);
    closeOtherPhone();
    expect(tracker.ids()).toEqual([]);
  });

  it("makes each stream cleanup idempotent", () => {
    const tracker = createConnectedDeviceTracker();
    const close = tracker.open("phone-1");

    close();
    close();
    expect(tracker.ids()).toEqual([]);
  });

  it("terminates every stream for a revoked device with idempotent cleanup", () => {
    const tracker = createConnectedDeviceTracker();
    const terminateFirst = vi.fn();
    const terminateSecond = vi.fn();
    const closeFirst = tracker.open("phone-1", terminateFirst);
    const closeSecond = tracker.open("phone-1", terminateSecond);
    tracker.open("phone-2");

    expect(tracker.disconnect("phone-1")).toBe(true);
    expect(tracker.ids()).toEqual(["phone-2"]);
    expect(terminateFirst).toHaveBeenCalledOnce();
    expect(terminateSecond).toHaveBeenCalledOnce();

    closeFirst();
    closeSecond();
    expect(tracker.disconnect("phone-1")).toBe(false);
    expect(terminateFirst).toHaveBeenCalledOnce();
    expect(terminateSecond).toHaveBeenCalledOnce();
  });
});
