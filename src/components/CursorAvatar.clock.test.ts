// @vitest-environment happy-dom
import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { MausAvatar, type MausAvatarHandle, type MausAvatarProps } from "./Avatar";
import { EFFECTS, EXPRESSIONS, POOLS } from "./CursorAvatar";
import { mascotClock } from "./mascot-clock";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const observed: { callback: ((entries: Array<{ target: Element; isIntersecting: boolean }>) => void) | null } = { callback: null };
class FakeIntersectionObserver {
  constructor(callback: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void) {
    observed.callback = callback;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);

let reducedMotion = false;
const motionListeners = new Set<() => void>();
vi.stubGlobal("matchMedia", (query: string) => ({
  get matches() { return query.includes("reduce") && reducedMotion; },
  addEventListener: (_: string, listener: () => void) => motionListeners.add(listener),
  removeEventListener: (_: string, listener: () => void) => motionListeners.delete(listener),
}));

let frameRequests = 0;
let host: HTMLDivElement;
let root: Root;

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  const raf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
    frameRequests++;
    return raf(callback);
  };
});

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  frameRequests = 0;
  reducedMotion = false;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (avatars: Array<Partial<MausAvatarProps> & { ref?: React.Ref<MausAvatarHandle> }>) =>
  act(() => root.render(avatars.map((props, key) => createElement(MausAvatar, { key, color: "green", ...props }))));
const run = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const eyePaths = () => [...host.querySelectorAll("svg")].map((svg) => svg.querySelector("g[clip-path] path")!.getAttribute("d"));
const toPath = (ring: Array<[number, number]>) => "M" + ring.map((p) => p[0].toFixed(2) + " " + p[1].toFixed(2)).join("L") + "Z";

describe("CursorAvatar on the shared clock", () => {
  it("draws every animated mascot from one animation frame", () => {
    render(Array.from({ length: 12 }, () => ({ state: "working" as const, size: 36 })));
    run(100);
    frameRequests = 0;
    run(1000);
    expect(frameRequests).toBeGreaterThan(30);
    expect(frameRequests).toBeLessThanOrEqual(70);
    expect(mascotClock().pending()).toBe(12);
  });

  it("paints a still mascot with its state's face and then asks for nothing", () => {
    render([{ state: "sleeping", animated: false, size: 24 }]);
    run(100);
    expect(eyePaths()[0]).toBe(toPath(EXPRESSIONS[POOLS.sleeping[0]][0]));
    frameRequests = 0;
    run(2000);
    expect(frameRequests).toBe(0);
    expect(mascotClock().pending()).toBe(0);
  });

  it("redraws a still mascot when its look changes", () => {
    render([{ state: "idle", animated: false, size: 24, turn: 0 }]);
    run(100);
    const eye = () => host.querySelector("g[clip-path] path")!.getAttribute("transform");
    const before = eye();
    render([{ state: "idle", animated: false, size: 24, turn: 40 }]);
    run(100);
    expect(eye()).not.toBe(before);
    expect(mascotClock().pending()).toBe(0);
  });

  it("lets a small idle mascot settle to no frames, and wakes it for a blink", () => {
    const ref = createRef<MausAvatarHandle>();
    render([{ state: "idle", size: 24, ref }]);
    run(3000);
    expect(mascotClock().pending()).toBe(0);
    frameRequests = 0;
    run(2000);
    expect(frameRequests).toBe(0);
    act(() => ref.current!.blink());
    run(500);
    expect(frameRequests).toBeGreaterThan(5);
    expect(mascotClock().pending()).toBe(0);
  });

  it("leaves an alert glyph's layer alone between its appearances", () => {
    render([{ state: "confused", size: 64 }]);
    const { period } = EFFECTS.confused!.glyph!;
    run(period - (performance.now() % period) + 100);
    const glyphLayer = [...host.querySelectorAll("svg g")].find((g) => (g as SVGGElement).style.opacity === "0")!;
    const writes = vi.spyOn(glyphLayer, "setAttribute");
    run(3000);
    expect(writes).not.toHaveBeenCalled();
    run(1500);
    expect(writes).toHaveBeenCalled();
  });

  it("stops drawing a mascot that leaves the screen", () => {
    render([{ state: "working", size: 36 }]);
    run(200);
    act(() => observed.callback!([{ target: host.querySelector("svg")!, isIntersecting: false }]));
    frameRequests = 0;
    run(1000);
    expect(frameRequests).toBe(0);
    act(() => observed.callback!([{ target: host.querySelector("svg")!, isIntersecting: true }]));
    run(500);
    expect(frameRequests).toBeGreaterThan(10);
  });

  it("holds still under reduced motion: no body motion, blinks or spins", () => {
    reducedMotion = true;
    const ref = createRef<MausAvatarHandle>();
    render([{ state: "celebrate", size: 220, ref }]);
    run(200);
    const svg = host.querySelector("svg")!;
    expect(svg.querySelector("g > g:nth-child(2)")!.getAttribute("transform")).toBeNull();
    frameRequests = 0;
    act(() => { ref.current!.blink(); ref.current!.spin(); });
    run(2000);
    expect(frameRequests).toBe(0);
    expect(mascotClock().pending()).toBe(0);
  });

  it("calms an animating mascot when reduced motion is switched on", () => {
    render([{ state: "working", size: 36 }]);
    run(200);
    expect(mascotClock().pending()).toBe(1);
    reducedMotion = true;
    act(() => { for (const listener of motionListeners) listener(); });
    run(200);
    expect(mascotClock().pending()).toBe(0);
  });
});
