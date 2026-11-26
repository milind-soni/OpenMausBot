// @vitest-environment happy-dom
import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { MausAvatar, type MausAvatarHandle, type MausAvatarProps } from "./Avatar";
import { mascotClock } from "./mascot-clock";
import { BLINK_MS, MOTION, PoseBlend, REST_POSE, blinkOpenness, bodyPose, criticalSpring, loopSeed } from "./mascot-motion";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);

let reducedMotion = false;
vi.stubGlobal("matchMedia", (query: string) => ({
  get matches() { return query.includes("reduce") && reducedMotion; },
  addEventListener: () => {},
  removeEventListener: () => {},
}));

let host: HTMLDivElement;
let root: Root;

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"] });
});

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  reducedMotion = false;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const render = (avatars: Array<Partial<MausAvatarProps> & { ref?: React.Ref<MausAvatarHandle> }>) =>
  act(() => root.render(avatars.map((props, key) => createElement(MausAvatar, { key, color: "green", ...props }))));
const run = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const svgs = () => [...host.querySelectorAll("svg")];
const bodyOf = (svg: SVGSVGElement) => svg.querySelector(":scope > g > g:nth-child(2)")!;
const eyeOf = (svg: SVGSVGElement) => svg.querySelector("g[clip-path] path")!;

function watch() {
  const records: MutationRecord[] = [];
  const observer = new MutationObserver((batch) => records.push(...batch));
  observer.observe(host, { attributes: true, childList: true, subtree: true, characterData: true });
  const all = () => {
    records.push(...observer.takeRecords());
    return records;
  };
  return {
    attributes: () => all().filter((r) => r.type === "attributes"),
    nodes: () => all().filter((r) => r.type === "childList"),
    stop: () => observer.disconnect(),
  };
}

function placeAt(svg: SVGSVGElement, size: number) {
  vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({ left: 100, top: 100, width: size, height: size, right: 100 + size, bottom: 100 + size, x: 100, y: 100, toJSON: () => ({}) });
}
const pointer = (type: string, x: number, y: number) => {
  const event = new MouseEvent(type, { clientX: x, clientY: y, bubbles: type !== "pointerenter" && type !== "pointerleave" });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  return event;
};

describe("blink", () => {
  it("closes eased, holds shut, opens past wide and lands, all in 260 ms", () => {
    expect(BLINK_MS).toBe(260);
    expect(blinkOpenness(0)).toBe(1);
    expect(blinkOpenness(20)!).toBeGreaterThan(blinkOpenness(45)!);
    expect(1 - blinkOpenness(10)!).toBeLessThan(0.1);
    const shut = blinkOpenness(95)!;
    expect(shut).toBeLessThan(0.1);
    expect(blinkOpenness(110)).toBe(shut);
    const opening = Array.from({ length: 136 }, (_, i) => blinkOpenness(124 + i)!);
    expect(Math.max(...opening)).toBeGreaterThan(1.02);
    expect(opening.at(-1)!).toBeCloseTo(1, 2);
    expect(blinkOpenness(BLINK_MS)).toBeNull();
  });
});

describe("blends", () => {
  it("springs to its target without overshoot in about 300 ms", () => {
    const samples = Array.from({ length: 60 }, (_, i) => criticalSpring(1, 0, i / 120).x);
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(0);
    expect(criticalSpring(1, 0, 0.3).x).toBeLessThan(0.1);
    expect(criticalSpring(1, 0, 0.6).x).toBeLessThan(0.005);
  });

  it("starts from the shown pose, reaches the target, and picks up mid-blend when interrupted", () => {
    const blend = new PoseBlend();
    const from = { ...REST_POSE, y: -10, rotate: 6 };
    blend.retarget(1000, from, REST_POSE);
    expect(blend.apply(1000, REST_POSE)).toEqual(from);
    const midway = blend.apply(1080, REST_POSE);
    expect(midway.y).toBeGreaterThan(-10);
    expect(midway.y).toBeLessThan(0);
    const next = { ...REST_POSE, x: 8 };
    blend.retarget(1080, midway, next);
    const resumed = blend.apply(1080, next);
    expect(resumed.y).toBeCloseTo(midway.y, 6);
    expect(resumed.x).toBeCloseTo(0, 6);
    expect(blend.apply(2500, next)).toEqual(next);
    expect(blend.blending).toBe(false);
  });
});

describe("loops", () => {
  it("are authored with holds rather than sines, and differ from bot to bot", () => {
    const seed = { phase: 0, variant: 0 };
    const [, period] = MOTION.working.bob;
    const y = (at: number) => bodyPose(MOTION.working, at * period, 1, { seed }).y;
    expect(y(0.25)).toBeCloseTo(y(0.33), 6);
    expect(y(0.25)).not.toBeCloseTo(y(0.1), 1);
    const a = loopSeed("first bot");
    const b = loopSeed("second bot");
    expect(a).not.toEqual(b);
    const sway = (s: typeof a) => bodyPose(MOTION.thinking, 777, 1, { seed: s }).rotate;
    expect(sway(a)).not.toBeCloseTo(sway(b), 2);
  });

  it("gives each mascot its own phase so a list never moves in step", () => {
    render([{ state: "working", size: 60 }, { state: "working", size: 60 }]);
    run(700);
    const [one, two] = svgs();
    expect(bodyOf(one!).getAttribute("transform")).not.toBe(bodyOf(two!).getAttribute("transform"));
  });
});

describe("CursorAvatar at rest and under the pointer", () => {
  it.each([24, 36, 60, 86])("writes nothing at rest at %i px", (size) => {
    render([{ state: "idle", size }, { state: "happy", size, animated: false }]);
    run(500);
    const changes = watch();
    run(20_000);
    expect(changes.attributes()).toEqual([]);
    changes.stop();
    expect(mascotClock().pending()).toBe(0);
  });

  it("follows the pointer within its neighbourhood, blinks, then settles and drops its listener", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const adds = vi.spyOn(document, "addEventListener");
    const removes = vi.spyOn(document, "removeEventListener");
    render([{ state: "idle", size: 36, animated: false }]);
    run(200);
    const svg = svgs()[0]!;
    placeAt(svg, 36);
    const moves = () => adds.mock.calls.filter(([type]) => type === "pointermove").length - removes.mock.calls.filter(([type]) => type === "pointermove").length;
    const eyeBefore = eyeOf(svg).getAttribute("transform");
    const changes = watch();
    act(() => { svg.dispatchEvent(pointer("pointerenter", 150, 118)); });
    expect(moves()).toBe(1);
    run(120);
    const shift = svg.querySelector("g[clip-path] > g > g")!;
    expect(shift.getAttribute("transform")).toMatch(/^translate\(\d/);
    run(900);
    expect(eyeOf(svg).getAttribute("transform")).toBe(eyeBefore);
    expect(changes.attributes().some((r) => r.target === eyeOf(svg) && r.attributeName === "transform")).toBe(true);
    act(() => { svg.dispatchEvent(pointer("pointerleave", 160, 118)); });
    act(() => { document.dispatchEvent(pointer("pointermove", 175, 118)); });
    expect(moves()).toBe(1);
    act(() => { document.dispatchEvent(pointer("pointermove", 400, 118)); });
    expect(moves()).toBe(0);
    run(1500);
    expect(shift.getAttribute("transform")).toBeNull();
    expect(mascotClock().pending()).toBe(0);
    expect(changes.nodes()).toEqual([]);
    changes.stop();
  });

  it("drops its pointer listener when unmounted mid-hover", () => {
    const adds = vi.spyOn(document, "addEventListener");
    const removes = vi.spyOn(document, "removeEventListener");
    render([{ state: "idle", size: 36 }]);
    run(100);
    const svg = svgs()[0]!;
    placeAt(svg, 36);
    act(() => { svg.dispatchEvent(pointer("pointerenter", 118, 118)); });
    act(() => root.unmount());
    const added = adds.mock.calls.filter(([type]) => type === "pointermove");
    const removed = removes.mock.calls.filter(([type]) => type === "pointermove");
    expect(added).toHaveLength(1);
    expect(removed.map(([, listener]) => listener)).toEqual(added.map(([, listener]) => listener));
    root = createRoot(host);
  });

  it("blends a change of state instead of cutting, then stops", () => {
    render([{ state: "working", size: 60, animated: true }]);
    run(450);
    const body = bodyOf(svgs()[0]!);
    const working = body.getAttribute("transform");
    expect(working).toBeTruthy();
    const changes = watch();
    render([{ state: "idle", size: 60, animated: false }]);
    run(40);
    expect(body.getAttribute("transform")).toBeTruthy();
    run(1500);
    expect(body.getAttribute("transform")).toBeNull();
    expect(mascotClock().pending()).toBe(0);
    expect(changes.nodes()).toEqual([]);
    changes.stop();
  });

  it("only blinks on its own while engaged", () => {
    render([{ state: "idle", size: 60, animated: false }, { state: "working", size: 60, animated: true }]);
    run(300);
    const [resting, working] = svgs();
    const changes = watch();
    run(15_000);
    const blinked = (svg: SVGSVGElement) => changes.attributes().some((r) => r.target === eyeOf(svg) && r.attributeName === "transform");
    expect(blinked(resting!)).toBe(false);
    expect(blinked(working!)).toBe(true);
    changes.stop();
  });

  it("rewrites only the eye heights through a blink", () => {
    const ref = createRef<MausAvatarHandle>();
    render([{ state: "idle", size: 60, animated: false, ref }]);
    run(300);
    const changes = watch();
    act(() => ref.current!.blink());
    run(BLINK_MS + 100);
    const touched = new Set(changes.attributes().map((r) => `${(r.target as Element).tagName}.${r.attributeName}`));
    expect([...touched]).toEqual(["path.transform"]);
    expect(changes.attributes().length).toBeLessThanOrEqual(2 * Math.ceil((BLINK_MS + 100) / (1000 / 30)));
    changes.stop();
  });

  it("holds still under reduced motion, pointer included", () => {
    reducedMotion = true;
    const adds = vi.spyOn(document, "addEventListener");
    render([{ state: "working", size: 60, animated: true }]);
    run(200);
    const svg = svgs()[0]!;
    placeAt(svg, 60);
    const changes = watch();
    act(() => { svg.dispatchEvent(pointer("pointerenter", 130, 130)); });
    run(3000);
    expect(adds.mock.calls.filter(([type]) => type === "pointermove")).toEqual([]);
    expect(changes.attributes()).toEqual([]);
    expect(mascotClock().pending()).toBe(0);
    changes.stop();
  });

  it("holds a festival body still at rest and wakes it under the pointer", () => {
    render([{ state: "idle", size: 44, bodyId: "pumpkin" }]);
    run(1000);
    const changes = watch();
    run(10_000);
    expect(changes.attributes()).toEqual([]);
    const span = host.querySelector("[data-carved-body]")!.parentElement!;
    const over = pointer("pointerover", 120, 120);
    Object.defineProperty(over, "relatedTarget", { value: null });
    act(() => { span.dispatchEvent(over); });
    run(500);
    expect(changes.attributes().length).toBeGreaterThan(50);
    const out = pointer("pointerout", 400, 400);
    Object.defineProperty(out, "relatedTarget", { value: document.body });
    act(() => { span.dispatchEvent(out); });
    run(3000);
    expect(mascotClock().pending()).toBe(0);
    expect(changes.nodes()).toEqual([]);
    changes.stop();
  });

  it("follows from anywhere in its row and lets go when the pointer leaves the row", () => {
    const adds = vi.spyOn(document, "addEventListener");
    const removes = vi.spyOn(document, "removeEventListener");
    act(() => root.render(createElement("button", { type: "button" }, createElement(MausAvatar, { color: "green", state: "idle", size: 36, animated: false }))));
    run(200);
    const svg = svgs()[0]!;
    placeAt(svg, 36);
    const row = host.querySelector("button")!;
    const listening = () => adds.mock.calls.filter(([type]) => type === "pointermove").length - removes.mock.calls.filter(([type]) => type === "pointermove").length;
    act(() => { row.dispatchEvent(pointer("pointerenter", 400, 118)); });
    expect(listening()).toBe(1);
    act(() => { document.dispatchEvent(pointer("pointermove", 420, 118)); });
    run(300);
    const shift = svg.querySelector("g[clip-path] > g > g")!;
    expect(shift.getAttribute("transform")).toMatch(/^translate\(\d/);
    act(() => { row.dispatchEvent(pointer("pointerleave", 500, 118)); });
    expect(listening()).toBe(0);
    run(1500);
    expect(shift.getAttribute("transform")).toBeNull();
    expect(mascotClock().pending()).toBe(0);
  });

  it.each(["excited", "alerting", "celebrate"] as const)("only glances and breathes when a resting %s mascot is hovered", (state) => {
    render([{ state, size: 56, animated: false }]);
    run(300);
    const svg = svgs()[0]!;
    placeAt(svg, 56);
    act(() => { svg.dispatchEvent(pointer("pointerenter", 128, 128)); });
    const glyph = bodyOf(svg).children[1] as SVGGElement;
    let lowest = 0;
    let glyphShown = false;
    for (let i = 0; i < 70; i++) {
      run(50);
      const lift = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(bodyOf(svg).getAttribute("transform") ?? "");
      lowest = Math.min(lowest, Number(lift?.[2] ?? 0));
      glyphShown ||= glyph.childElementCount > 0 || glyph.style.opacity !== "0";
    }
    expect(lowest).toBeGreaterThan(-1);
    expect(glyphShown).toBe(false);
    expect(svg.querySelector(":scope > g > g:first-child")!.childElementCount).toBe(0);
    expect(svg.querySelector(":scope > g > g:last-child")!.childElementCount).toBe(0);
  });

  it("plays a festival body's beats and spins when nothing animates it, and never sticks wide-eyed", () => {
    const ref = createRef<MausAvatarHandle>();
    render([{ state: "idle", size: 44, bodyId: "pumpkin", ref }]);
    run(1000);
    const smile = host.querySelector("[data-carved-body] path[stroke]") as SVGPathElement;
    const changes = watch();
    render([{ state: "idle", size: 44, bodyId: "pumpkin", ref, motion: "surprise", motionKey: 1 }]);
    run(200);
    expect(Number(smile.style.opacity)).toBeLessThan(0.1);
    run(3000);
    expect(smile.style.opacity).toBe("1");
    expect(mascotClock().pending()).toBe(0);
    const before = changes.attributes().length;
    act(() => ref.current!.spin());
    run(300);
    expect(changes.attributes().length).toBeGreaterThan(before);
    run(3000);
    expect(mascotClock().pending()).toBe(0);
    changes.stop();
  });
});
