import type { EffectCallback } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ effects: [] as EffectCallback[] }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useRef: (initial: unknown) => ({ current: initial }),
  useEffect: (effect: EffectCallback) => { fixture.effects.push(effect); },
}));

import { popoverClosesOnKey, popoverClosesOnPointer, usePopoverDismiss } from "./use-popover-dismiss";

const key = (patch: Partial<KeyboardEvent> = {}) => ({ key: "Escape", defaultPrevented: false, isComposing: false, ...patch });
const INSIDE = { closest: () => null };
const root = { contains: (target: unknown) => target === INSIDE };

afterEach(() => { vi.unstubAllGlobals(); fixture.effects = []; });

describe("popover dismissal", () => {
  it("closes on a fresh Escape only", () => {
    expect(popoverClosesOnKey(key())).toBe(true);
    expect(popoverClosesOnKey(key({ key: "Enter" }))).toBe(false);
    // an editor closing its own suggestion list already claimed this Escape
    expect(popoverClosesOnKey(key({ defaultPrevented: true }))).toBe(false);
    expect(popoverClosesOnKey(key({ isComposing: true }))).toBe(false);
  });

  it("closes on a press outside, never inside or on the tour card", () => {
    expect(popoverClosesOnPointer({ closest: () => null } as unknown as EventTarget, root)).toBe(true);
    expect(popoverClosesOnPointer(INSIDE as unknown as EventTarget, root)).toBe(false);
    const tourCard = { closest: (selector: string) => selector === "[data-tour-card]" ? {} : null };
    expect(popoverClosesOnPointer(tourCard as unknown as EventTarget, root)).toBe(false);
    expect(popoverClosesOnPointer(null, root)).toBe(false);
    expect(popoverClosesOnPointer(INSIDE as unknown as EventTarget, null)).toBe(false);
  });

  it("listens only while open and removes its listeners on close", () => {
    const window = new EventTarget();
    vi.stubGlobal("window", window);
    const close = vi.fn();
    const escape = (prevented = false) => {
      const event = Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape", isComposing: false });
      if (prevented) event.preventDefault();
      window.dispatchEvent(event);
      return event;
    };

    usePopoverDismiss(false, { current: root }, close);
    expect(fixture.effects[0]!()).toBeUndefined();

    usePopoverDismiss(true, { current: root }, close);
    const cleanup = fixture.effects[1]!() as () => void;
    escape(true);
    expect(close).not.toHaveBeenCalled();
    expect(escape().defaultPrevented).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);

    cleanup();
    escape();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
