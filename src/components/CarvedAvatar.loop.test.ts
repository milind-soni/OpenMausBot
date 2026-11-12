// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMascotClock, type ClockEnvironment } from "./mascot-clock";

/** A clock whose time only moves when the test moves it, so the frames it asks for can be counted. */
function fakeClock() {
  let time = 1_000;
  let asked = 0;
  const frames: Array<(now: number) => void> = [];
  const timers: Array<{ at: number; run: () => void }> = [];
  const env: ClockEnvironment = {
    now: () => time,
    requestFrame: (callback) => { asked += 1; frames.push(callback); return asked; },
    cancelFrame: () => {},
    setTimer: (callback, ms) => { timers.push({ at: time + ms, run: callback }); return timers.length; },
    clearTimer: () => {},
    watchVisibility: () => null,
    documentHidden: () => false,
    onDocumentVisibility: () => {},
  };
  const advance = (ms: number) => {
    const until = time + ms;
    while (time < until) {
      const nextTimer = timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
      if (nextTimer && nextTimer.at <= time) {
        timers.splice(timers.indexOf(nextTimer), 1);
        nextTimer.run();
        continue;
      }
      if (frames.length) {
        time = Math.min(until, time + 16);
        frames.shift()!(time);
        continue;
      }
      if (nextTimer) {
        time = nextTimer.at;
        timers.splice(timers.indexOf(nextTimer), 1);
        nextTimer.run();
        continue;
      }
      break;
    }
    time = until;
  };
  return { env, advance, asked: () => asked };
}

const clocks = vi.hoisted(() => ({ current: undefined as ReturnType<typeof createMascotClock> | undefined }));

vi.mock("./mascot-clock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mascot-clock")>();
  return { ...actual, mascotClock: () => clocks.current!, usePrefersReducedMotion: () => false };
});

afterEach(() => { document.body.innerHTML = ""; });

describe("a carved face on the clock", () => {
  it("stops drawing once it has settled, and still wakes for its blink", async () => {
    const { CarvedAvatar } = await import("./CarvedAvatar");
    const { env, advance, asked } = fakeClock();
    clocks.current = createMascotClock(env);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    // A thinking face does not glance, so once it has arrived only its own blink is left to draw.
    await act(async () => { root.render(createElement(CarvedAvatar, { body: "pumpkin", color: "orange", state: "thinking" })); });

    advance(2_000);
    const settled = asked();
    advance(10_000);
    const drawing = asked() - settled;

    // Twenty frames a second for ten seconds is 200; a face that only blinks asks for a few each time.
    expect(drawing).toBeGreaterThan(0);
    expect(drawing).toBeLessThan(60);
    await act(async () => { root.unmount(); });
  });

  it("still sleeps while a pointer rests over it, and wakes when the pointer moves", async () => {
    const { CarvedAvatar } = await import("./CarvedAvatar");
    const { env, advance, asked } = fakeClock();
    clocks.current = createMascotClock(env);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => { root.render(createElement(CarvedAvatar, { body: "pumpkin", color: "orange", state: "thinking" })); });
    advance(2_000);

    const face = host.querySelector("span")!;
    face.getBoundingClientRect = () => ({ left: 0, top: 0, width: 44, height: 44, right: 44, bottom: 44, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const moveTo = (clientX: number, clientY: number) => {
      face.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX, clientY }));
    };
    const beforePointer = asked();
    await act(async () => { moveTo(30, 20); });
    expect(asked()).toBeGreaterThan(beforePointer);
    advance(500);

    const settled = asked();
    advance(10_000);
    // Fifty frames a second for ten seconds would be 500; a gaze that has arrived asks for nothing new.
    expect(asked() - settled).toBeLessThan(60);

    const beforeCue = asked();
    await act(async () => { moveTo(20, 10); });
    expect(asked()).toBeGreaterThan(beforeCue);
    await act(async () => { root.unmount(); });
  });

  it("wakes for a blink cue instead of waiting for the next glance", async () => {
    const { CarvedAvatar } = await import("./CarvedAvatar");
    const random = vi.spyOn(Math, "random").mockReturnValue(0.999);
    const { env, advance, asked } = fakeClock();
    clocks.current = createMascotClock(env);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const render = (motionKey: number) => createElement(CarvedAvatar, { body: "pumpkin", color: "orange", state: "thinking", motion: "blink", motionKey });
    await act(async () => { root.render(render(0)); });
    advance(2_000);

    // A resting face has no frame pending; the cue itself has to ask for the one that draws the blink.
    const settled = asked();
    await act(async () => { root.render(render(1)); });
    expect(asked()).toBeGreaterThan(settled);
    random.mockRestore();
    await act(async () => { root.unmount(); });
  });

  it("draws a moving face at forty frames a second at most", async () => {
    const { CarvedAvatar } = await import("./CarvedAvatar");
    const { env, advance, asked } = fakeClock();
    clocks.current = createMascotClock(env);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => { root.render(createElement(CarvedAvatar, { body: "pumpkin", color: "orange", size: 120, state: "thinking", motion: "success" })); });

    advance(1_000);
    // A full-size face used to ask for sixty a second; forty is the ceiling however large it is drawn.
    expect(asked()).toBeLessThanOrEqual(45);
    expect(asked()).toBeGreaterThan(20);
    await act(async () => { root.unmount(); });
  });
});
