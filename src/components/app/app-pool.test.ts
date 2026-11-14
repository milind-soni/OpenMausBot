// @vitest-environment happy-dom
import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppPool, useAppPoolSlot, type AppPool, type AppPoolMember } from "./app-pool";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A member whose teardown finishes when the test says so. */
function member(log: string[], key: string) {
  let finish: () => void = () => {};
  const evict = vi.fn(() => new Promise<void>((resolve) => {
    log.push(`teardown ${key}`);
    finish = () => { log.push(`gone ${key}`); resolve(); };
  }));
  return { member: { evict } satisfies AppPoolMember, finish: () => finish(), evict };
}

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe("the pool", () => {
  let clock = 0;
  const now = () => clock;
  beforeEach(() => { clock = 1_000; });

  it("grants up to the limit at once", async () => {
    const pool = createAppPool({ limit: 3, now });
    const log: string[] = [];
    const granted = await Promise.all(["a", "b", "c"].map((key) => pool.acquire(key, member(log, key).member)));
    expect(granted).toEqual([true, true, true]);
    expect(pool.live()).toEqual(["a", "b", "c"]);
    expect(log).toEqual([]);
  });

  it("tears down the frame seen least recently, and mounts the fourth only once it is gone", async () => {
    const pool = createAppPool({ limit: 3, now });
    const log: string[] = [];
    const members = Object.fromEntries(["a", "b", "c", "d"].map((key) => [key, member(log, key)]));
    for (const key of ["a", "b", "c"]) {
      pool.seen(key, true);
      await pool.acquire(key, members[key]!.member);
      clock += 10;
    }
    // b left the view first, then a; c is still in view
    pool.seen("b", false); clock += 10;
    pool.seen("a", false); clock += 10;
    let fourth = false;
    pool.seen("d", true);
    const asked = pool.acquire("d", members.d!.member).then((granted) => { fourth = granted; });
    await Promise.resolve();
    expect(log).toEqual(["teardown b"]);
    // still three: b holds its slot until its teardown is done
    expect(pool.live()).toEqual(["a", "b", "c"]);
    expect(fourth).toBe(false);
    members.b!.finish();
    await asked;
    expect(fourth).toBe(true);
    expect(pool.live().sort()).toEqual(["a", "c", "d"]);
    expect(members.a!.evict).not.toHaveBeenCalled();
    expect(members.c!.evict).not.toHaveBeenCalled();
  });

  it("when every frame is in view, gives up the one that came into view first", async () => {
    const pool = createAppPool({ limit: 2, now });
    const log: string[] = [];
    const a = member(log, "a"), b = member(log, "b"), c = member(log, "c");
    pool.seen("a", true); await pool.acquire("a", a.member); clock += 5;
    pool.seen("b", true); await pool.acquire("b", b.member); clock += 5;
    pool.seen("c", true);
    const asked = pool.acquire("c", c.member);
    await Promise.resolve();
    expect(log).toEqual(["teardown a"]);
    a.finish();
    expect(await asked).toBe(true);
    expect(pool.live().sort()).toEqual(["b", "c"]);
  });

  it("frees a slot on release, and a withdrawn request resolves false", async () => {
    const pool = createAppPool({ limit: 1, now });
    const log: string[] = [];
    const a = member(log, "a"), b = member(log, "b");
    await pool.acquire("a", a.member);
    const waiting = pool.acquire("b", b.member);
    await Promise.resolve();
    expect(log).toEqual(["teardown a"]);
    pool.release("b");
    expect(await waiting).toBe(false);
    a.finish();
    await flush();
    expect(pool.live()).toEqual([]);
    expect(await pool.acquire("b", b.member)).toBe(true);
    pool.release("b");
    expect(pool.live()).toEqual([]);
  });

  it("asks a live frame for nothing when it asks again", async () => {
    const pool = createAppPool({ limit: 1, now });
    const log: string[] = [];
    const a = member(log, "a");
    await pool.acquire("a", a.member);
    expect(await pool.acquire("a", a.member)).toBe(true);
    expect(log).toEqual([]);
  });
});

describe("a row's slot", () => {
  let host: HTMLDivElement;
  let root: Root;
  let observers: Array<{ callback: IntersectionObserverCallback; element?: Element; options?: IntersectionObserverInit }>;

  beforeEach(() => {
    observers = [];
    vi.stubGlobal("IntersectionObserver", class {
      readonly entry: { callback: IntersectionObserverCallback; element?: Element; options?: IntersectionObserverInit };
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        this.entry = { callback, options };
        observers.push(this.entry);
      }
      observe(element: Element) { this.entry.element = element; }
      disconnect() {}
      unobserve() {}
      takeRecords() { return []; }
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  function Row({ id, pool, auto, onState, evict }: { id: string; pool: AppPool; auto: boolean; onState(live: boolean, open: () => void): void; evict(): Promise<void> }) {
    const target = useRef<HTMLDivElement | null>(null);
    const slot = useAppPoolSlot({ key: id, target, auto, evict, pool });
    onState(slot.live, slot.open);
    return createElement("div", { ref: target, "data-row": id });
  }

  const intersect = (index: number, visible: boolean) => act(async () => {
    const entry = observers[index]!;
    entry.callback([{ isIntersecting: visible, target: entry.element! } as IntersectionObserverEntry], {} as IntersectionObserver);
    await Promise.resolve();
  });

  it("mounts when the row comes within 300px of the view, and keeps to the budget", async () => {
    const pool = createAppPool({ limit: 2 });
    const states: Record<string, boolean> = {};
    const evicted: string[] = [];
    act(() => root.render(createElement("div", null, ["r1", "r2", "r3"].map((id) => createElement(Row, {
      key: id, id, pool, auto: true,
      onState: (live: boolean) => { states[id] = live; },
      evict: async () => { evicted.push(id); },
    })))));
    expect(observers.map((entry) => entry.options?.rootMargin)).toEqual(["300px 0px", "300px 0px", "300px 0px"]);
    expect(states).toEqual({ r1: false, r2: false, r3: false });
    await intersect(0, true);
    await intersect(1, true);
    expect(states).toEqual({ r1: true, r2: true, r3: false });
    await intersect(0, false);
    await intersect(2, true);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(evicted).toEqual(["r1"]);
    expect(states).toEqual({ r1: false, r2: true, r3: true });
    expect(pool.live().sort()).toEqual(["r2", "r3"]);
  });

  it("an older row waits for Open app", async () => {
    const pool = createAppPool({ limit: 3 });
    let live = false;
    let open: () => void = () => {};
    act(() => root.render(createElement(Row, { id: "old", pool, auto: false, onState: (state: boolean, opener: () => void) => { live = state; open = opener; }, evict: async () => {} })));
    await intersect(0, true);
    expect(live).toBe(false);
    await act(async () => { open(); await Promise.resolve(); });
    expect(live).toBe(true);
    expect(pool.live()).toEqual(["old"]);
  });

  it("gives its slot back when the row goes", async () => {
    const pool = createAppPool({ limit: 3 });
    act(() => root.render(createElement(Row, { id: "gone", pool, auto: true, onState: () => {}, evict: async () => {} })));
    await intersect(0, true);
    expect(pool.live()).toEqual(["gone"]);
    act(() => root.render(createElement("div")));
    expect(pool.live()).toEqual([]);
  });
});
