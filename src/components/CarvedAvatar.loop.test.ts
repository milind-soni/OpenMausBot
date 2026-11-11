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
});
