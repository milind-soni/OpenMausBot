import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// There is no DOM here, so a few lines stand in for React: state held by call
// order, layout effects run after each render when their deps change, and a
// state change renders again, the way React settles before it paints.
const react = vi.hoisted(() => {
  const slots: unknown[] = [];
  const effects: Array<{ deps: unknown[]; cleanup: void | (() => void) }> = [];
  let queued: Array<() => void> = [];
  let cursor = 0;
  let effectCursor = 0;
  let changed = false;
  return {
    reset() {
      for (const effect of effects) if (typeof effect.cleanup === "function") effect.cleanup();
      slots.length = 0;
      effects.length = 0;
    },
    render<T>(hook: () => T): T {
      let result: T;
      let passes = 0;
      do {
        if (++passes > 10) throw new Error("hook never settled");
        changed = false;
        cursor = 0;
        effectCursor = 0;
        queued = [];
        result = hook();
        for (const run of queued) run();
      } while (changed);
      return result;
    },
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (next: unknown) => {
        const value = typeof next === "function" ? (next as (current: unknown) => unknown)(slots[index]) : next;
        if (Object.is(value, slots[index])) return;
        slots[index] = value;
        changed = true;
      }];
    },
    useRef(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useLayoutEffect(effect: () => void | (() => void), deps: unknown[]) {
      const index = effectCursor++;
      const previous = effects[index];
      if (previous && deps.every((dep, at) => Object.is(dep, previous.deps[at]))) return;
      queued.push(() => {
        if (typeof previous?.cleanup === "function") previous.cleanup();
        effects[index] = { deps, cleanup: effect() };
      });
    },
    get changed() { return changed; },
  };
});
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: react.useState,
  useRef: react.useRef,
  useLayoutEffect: react.useLayoutEffect,
}));

const { MENU_MOTION_MS, useHeldMenuMotion, useMenuMotion } = await import("./MenuMotion");

let reduced = false;
beforeEach(() => {
  vi.useFakeTimers();
  reduced = false;
  vi.stubGlobal("window", {
    setTimeout: (run: () => void, ms: number) => setTimeout(run, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    matchMedia: () => ({ matches: reduced }),
  });
  vi.stubGlobal("document", { documentElement: { dataset: {} } });
});
afterEach(() => {
  react.reset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("menu motion", () => {
  it("shows a menu on the render it opens and pops it in", () => {
    expect(react.render(() => useMenuMotion(false))).toMatchObject({ shown: false, closing: false });
    const open = react.render(() => useMenuMotion(true));
    expect(open).toMatchObject({ shown: true, closing: false, className: "animate-pop-in", exitProps: {} });
  });

  it("keeps a closing menu on screen for the pop, but out of reach and out of the accessibility tree", () => {
    react.render(() => useMenuMotion(true));
    const closing = react.render(() => useMenuMotion(false));
    expect(closing.shown).toBe(true);
    expect(closing.closing).toBe(true);
    expect(closing.className).toBe("animate-pop-out pointer-events-none");
    expect(closing.exitProps).toEqual({ inert: true, "aria-hidden": true });
    vi.advanceTimersByTime(MENU_MOTION_MS - 1);
    expect(react.render(() => useMenuMotion(false)).shown).toBe(true);
    vi.advanceTimersByTime(1);
    expect(react.changed).toBe(true);
    expect(react.render(() => useMenuMotion(false))).toMatchObject({ shown: false, closing: false, exitProps: {} });
  });

  it("closes at once under reduced motion", () => {
    reduced = true;
    react.render(() => useMenuMotion(true));
    expect(react.render(() => useMenuMotion(false))).toMatchObject({ shown: false, closing: false, exitProps: {} });
  });

  it("reopens a menu that is still closing as a live menu", () => {
    react.render(() => useMenuMotion(true));
    react.render(() => useMenuMotion(false));
    const reopened = react.render(() => useMenuMotion(true));
    expect(reopened).toMatchObject({ shown: true, closing: false, className: "animate-pop-in", exitProps: {} });
    vi.advanceTimersByTime(MENU_MOTION_MS * 2);
    expect(react.render(() => useMenuMotion(true)).shown).toBe(true);
  });

  it("holds the last payload while a positioned menu closes", () => {
    const anchor = { x: 10, y: 20 };
    react.render(() => useHeldMenuMotion(anchor));
    const closing = react.render(() => useHeldMenuMotion<typeof anchor>(null));
    expect(closing).toMatchObject({ shown: true, closing: true, value: anchor });
    expect(closing.exitProps).toEqual({ inert: true, "aria-hidden": true });
  });
});
