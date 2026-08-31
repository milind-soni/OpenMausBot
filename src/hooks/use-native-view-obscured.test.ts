import { describe, expect, it, vi } from "vitest";

import { syncNativeViewResizeTargets } from "./use-native-view-obscured";

describe("native view resize targets", () => {
  it("observes new overlays once and unobserves stale candidates", () => {
    const observer = {
      observe: vi.fn(),
      unobserve: vi.fn(),
    };
    const observed = new Set<{ name: string }>();
    const body = { name: "body" };
    const host = { name: "host" };
    const firstOverlay = { name: "first overlay" };
    const secondOverlay = { name: "second overlay" };

    syncNativeViewResizeTargets(observer, observed, [body, host, firstOverlay]);
    expect(observer.observe.mock.calls.map(([target]) => target)).toEqual([
      body,
      host,
      firstOverlay,
    ]);

    syncNativeViewResizeTargets(observer, observed, [body, host, firstOverlay]);
    expect(observer.observe).toHaveBeenCalledTimes(3);
    expect(observer.unobserve).not.toHaveBeenCalled();

    syncNativeViewResizeTargets(observer, observed, [body, host, secondOverlay]);
    expect(observer.unobserve).toHaveBeenCalledWith(firstOverlay);
    expect(observer.observe).toHaveBeenLastCalledWith(secondOverlay);
    expect(observed).toEqual(new Set([body, host, secondOverlay]));
  });
});
