import { afterEach, describe, expect, it } from "vitest";

import { createEventLoopStalls, LOOP_TIMER_MS, STALL_MS, type EventLoopStalls } from "./event-loop-stalls.ts";

let watch: EventLoopStalls | null = null;
afterEach(() => { watch?.close(); watch = null; });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("this process's event loop stalls", () => {
  it("are seen in the window they fall in, and not in one that ended before them", async () => {
    watch = createEventLoopStalls(Date.now, { sampleMs: 50, stallMs: 1_000 });
    await pause(200);
    const before = Date.now();
    // Held for well over the threshold: a margin of more than a second.
    for (const end = Date.now() + 2_500; Date.now() < end;) { /* the stall */ }
    await pause(200);
    expect(watch.stalledBetween(before, Date.now())).toBe(true);
    expect(watch.stalledBetween(before - 10_000, before - 5_000)).toBe(false);
  });

  it("wakes an idle server only a couple of times a second, and still sees every stall", () => {
    // The longest interval read includes the timer's own, so any timer shorter than a stall sees it; one longer would
    // read every quiet interval as a stall.
    expect(LOOP_TIMER_MS).toBeGreaterThanOrEqual(250);
    expect(LOOP_TIMER_MS).toBeLessThan(STALL_MS);
  });
});
