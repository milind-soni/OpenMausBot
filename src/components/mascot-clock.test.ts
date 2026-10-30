import { describe, expect, it } from "vitest";

import { createMascotClock, type ClockEnvironment } from "./mascot-clock";
import { FULL_FRAME_MS, nextFrameAt } from "./mascot-motion";

function fakeEnvironment(refreshHz = 60) {
  let now = 0;
  let nextHandle = 1;
  const frames = new Map<number, (now: number) => void>();
  const timers = new Map<number, { at: number; run: () => void }>();
  let visibility: ((changes: Array<{ target: Element; isIntersecting: boolean }>) => void) | null = null;
  let hidden = false;
  const visibilityListeners: Array<() => void> = [];
  const stats = { frameRequests: 0, timerRequests: 0 };
  const env: ClockEnvironment = {
    now: () => now,
    requestFrame(callback) {
      stats.frameRequests++;
      const handle = nextHandle++;
      frames.set(handle, callback);
      return handle;
    },
    cancelFrame: (handle) => frames.delete(handle),
    setTimer(run, ms) {
      stats.timerRequests++;
      const handle = nextHandle++;
      timers.set(handle, { at: now + ms, run });
      return handle;
    },
    clearTimer: (handle) => timers.delete(handle as number),
    watchVisibility(onChange) {
      visibility = onChange;
      return { observe() {}, unobserve() {} };
    },
    documentHidden: () => hidden,
    onDocumentVisibility: (listener) => visibilityListeners.push(listener),
  };
  const vsync = 1000 / refreshHz;
  let tick = 0;
  return {
    env,
    stats,
    pendingFrames: () => frames.size,
    pendingTimers: () => timers.size,
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const nextVsync = (tick + 1) * vsync;
        const timer = [...timers.entries()].sort((x, y) => x[1].at - y[1].at)[0];
        if (timer && timer[1].at <= nextVsync) {
          if (timer[1].at > end) break;
          now = Math.max(now, timer[1].at);
          timers.delete(timer[0]);
          timer[1].run();
          continue;
        }
        if (nextVsync > end) break;
        now = nextVsync;
        tick++;
        const due = [...frames.values()];
        frames.clear();
        for (const callback of due) callback(now);
      }
      now = end;
    },
    setOnScreen: (target: Element, isIntersecting: boolean) => visibility?.([{ target, isIntersecting }]),
    setHidden(value: boolean) {
      hidden = value;
      for (const listener of visibilityListeners) listener();
    },
  };
}

const element = (name: string) => ({ name }) as unknown as Element;

describe("mascot clock", () => {
  it("draws every mascot from one frame request", () => {
    const fake = fakeEnvironment();
    const clock = createMascotClock(fake.env);
    const drawn: string[] = [];
    for (const name of ["a", "b", "c"]) clock.add((now) => { drawn.push(name); return now + FULL_FRAME_MS; });
    expect(fake.stats.frameRequests).toBe(1);
    fake.advance(1001);
    expect(drawn.filter((name) => name === "a")).toHaveLength(60);
    expect(drawn).toHaveLength(180);
    expect(fake.stats.frameRequests).toBe(61);
  });

  it("caps full motion at 60 draws a second on a 120 Hz display", () => {
    const fake = fakeEnvironment(120);
    const clock = createMascotClock(fake.env);
    let draws = 0;
    clock.add((now) => { draws++; return now + FULL_FRAME_MS; });
    fake.advance(1000);
    expect(draws).toBeGreaterThanOrEqual(59);
    expect(draws).toBeLessThanOrEqual(61);
  });

  it("paints mascots that started on different frames together", () => {
    const fake = fakeEnvironment(120);
    const clock = createMascotClock(fake.env);
    const paintedAt = new Set<number>();
    clock.add((now) => { paintedAt.add(now); return nextFrameAt(now, FULL_FRAME_MS); });
    fake.advance(1000 / 120);
    clock.add((now) => { paintedAt.add(now); return nextFrameAt(now, FULL_FRAME_MS); });
    fake.advance(1000);
    expect(paintedAt.size).toBeLessThanOrEqual(63);
  });

  it("asks for no frames while every mascot is still, and one frame when woken", () => {
    const fake = fakeEnvironment();
    const clock = createMascotClock(fake.env);
    let draws = 0;
    const ticket = clock.add(() => { draws++; return Infinity; });
    fake.advance(1000);
    expect(draws).toBe(1);
    expect(fake.pendingFrames() + fake.pendingTimers()).toBe(0);
    expect(clock.pending()).toBe(0);
    ticket.wake();
    fake.advance(100);
    expect(draws).toBe(2);
    expect(fake.pendingFrames() + fake.pendingTimers()).toBe(0);
  });

  it("sleeps on a timer between slow frames instead of polling every display frame", () => {
    const fake = fakeEnvironment(120);
    const clock = createMascotClock(fake.env);
    let draws = 0;
    clock.add((now) => { draws++; return now + 50; });
    fake.advance(1000);
    expect(draws).toBeGreaterThanOrEqual(19);
    expect(draws).toBeLessThanOrEqual(21);
    expect(fake.stats.frameRequests).toBeLessThan(45);
  });

  it("skips a mascot that is off screen and draws it again when it scrolls back", () => {
    const fake = fakeEnvironment();
    const clock = createMascotClock(fake.env);
    const svg = element("svg");
    let draws = 0;
    clock.add((now) => { draws++; return now + FULL_FRAME_MS; }, svg);
    fake.advance(100);
    fake.setOnScreen(svg, false);
    const before = draws;
    fake.advance(1000);
    expect(draws).toBe(before);
    expect(fake.pendingFrames() + fake.pendingTimers()).toBe(0);
    fake.setOnScreen(svg, true);
    fake.advance(100);
    expect(draws).toBeGreaterThan(before + 4);
  });

  it("stops while the document is hidden and resumes when it is shown", () => {
    const fake = fakeEnvironment();
    const clock = createMascotClock(fake.env);
    let draws = 0;
    const ticket = clock.add((now) => { draws++; return now + 50; });
    fake.advance(200);
    fake.setHidden(true);
    expect(fake.pendingFrames() + fake.pendingTimers()).toBe(0);
    const before = draws;
    ticket.wake();
    fake.advance(2000);
    expect(draws).toBe(before);
    expect(fake.pendingFrames() + fake.pendingTimers()).toBe(0);
    fake.setHidden(false);
    fake.advance(200);
    expect(draws).toBeGreaterThan(before + 2);
  });

  it("forgets a removed mascot", () => {
    const fake = fakeEnvironment();
    const clock = createMascotClock(fake.env);
    let draws = 0;
    const ticket = clock.add((now) => { draws++; return now + FULL_FRAME_MS; });
    fake.advance(100);
    ticket.remove();
    const before = draws;
    fake.advance(500);
    expect(draws).toBe(before);
    expect(fake.pendingFrames() + fake.pendingTimers()).toBe(0);
  });

  it("does not retry a mascot whose frame threw until it is woken", () => {
    const fake = fakeEnvironment();
    const clock = createMascotClock(fake.env);
    let calls = 0;
    let other = 0;
    clock.add(() => { calls++; throw new Error("broken face"); });
    clock.add((now) => { other++; return now + FULL_FRAME_MS; });
    expect(() => fake.advance(20)).toThrow("broken face");
    fake.advance(500);
    expect(calls).toBe(1);
    expect(other).toBeGreaterThan(25);
  });
});
