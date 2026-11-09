import { afterEach, describe, expect, it, vi } from "vitest";

import { MISSES_BEFORE_RESTART, WATCH_EVERY_MS, restartWorthTrying, watchDriver } from "./cua-watch.mjs";

const tick = () => vi.advanceTimersByTimeAsync(WATCH_EVERY_MS);

describe("watching the computer-control driver", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("leaves a driver that answers alone", async () => {
    vi.useFakeTimers();
    const restart = vi.fn();
    const watch = watchDriver({ alive: async () => true, restart });
    for (let i = 0; i < 6; i++) await tick();
    expect(restart).not.toHaveBeenCalled();
    watch.stop();
  });

  it("starts it again once, after enough checks in a row have gone unanswered", async () => {
    vi.useFakeTimers();
    const restart = vi.fn(async () => {}), log = vi.fn();
    const watch = watchDriver({ alive: async () => false, restart, log });
    for (let i = 0; i < MISSES_BEFORE_RESTART - 1; i++) await tick();
    expect(restart).not.toHaveBeenCalled();
    for (let i = 0; i < 4; i++) await tick();
    expect(restart).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain("stopped answering");
    watch.stop();
  });

  it("forgives one missed check: a laptop waking from sleep isn't a dead driver", async () => {
    vi.useFakeTimers();
    const answers = [false, true, false, true, false, true];
    const restart = vi.fn();
    const watch = watchDriver({ alive: async () => answers.shift() ?? true, restart });
    for (let i = 0; i < 6; i++) await tick();
    expect(restart).not.toHaveBeenCalled();
    watch.stop();
  });

  it("counts a check that throws as unanswered", async () => {
    vi.useFakeTimers();
    const restart = vi.fn(async () => {});
    const watch = watchDriver({ alive: async () => { throw new Error("no socket"); }, restart, log: () => {} });
    for (let i = 0; i < MISSES_BEFORE_RESTART; i++) await tick();
    expect(restart).toHaveBeenCalledTimes(1);
    watch.stop();
  });

  it("does nothing once stopped", async () => {
    vi.useFakeTimers();
    const restart = vi.fn();
    const watch = watchDriver({ alive: async () => false, restart });
    watch.stop();
    for (let i = 0; i < 6; i++) await tick();
    expect(restart).not.toHaveBeenCalled();
  });

  it.each([
    ["Accessibility and Screen Recording required; grant access in System Settings and restart OpenMausBot", false],
    ["Computer use restart cancelled", false],
    ["embedded host failed: EmbeddedDriverError.Spawn; standalone launch failed: timed out", true],
    [undefined, true],
  ])("decides whether another try can help: %s", (message, worth) => {
    expect(restartWorthTrying(message)).toBe(worth);
  });
});
