import { afterEach, describe, expect, it } from "vitest";

import { createEventLoopStalls, LOOP_TIMER_MS, SAMPLE_MS, STALL_MS, type EventLoopStalls } from "./event-loop-stalls.ts";

let watch: EventLoopStalls | null = null;
afterEach(() => { watch?.close(); watch = null; });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Node's timers on one clock: each interval fires once it is due and is set again from when it ran; a stall moves the
 * clock with nothing running, then the overdue timers run in the order asked (the sample's before the tick, or after). */
function loop() {
  let time = 1_000_000;
  const timers: Array<{ ms: number; run: () => void; due: number; stopped: boolean; name: string }> = [];
  const every = (ms: number, run: () => void) => {
    const timer = { ms, run, due: time + ms, stopped: false, name: ms === LOOP_TIMER_MS ? "tick" : "sample" };
    timers.push(timer);
    return () => { timer.stopped = true; };
  };
  const fire = (timer: (typeof timers)[number]) => { timer.run(); timer.due = time + timer.ms; };
  return {
    every, clock: () => time, now: () => time,
    /** Runs every timer due up to `until`, earliest first. */
    runUntil(until: number) {
      for (;;) {
        const next = timers.filter((timer) => !timer.stopped && timer.due <= until).sort((a, b) => a.due - b.due)[0];
        if (!next) break;
        time = Math.max(time, next.due);
        fire(next);
      }
      time = until;
    },
    /** The loop is held for `ms`; then the timers that came due run, the sample's first when `sampleFirst`. */
    stall(ms: number, sampleFirst: boolean) {
      const start = time;
      time += ms;
      const due = timers.filter((timer) => !timer.stopped && timer.due <= time)
        .sort((a, b) => (a.name === b.name ? 0 : (a.name === "sample") === sampleFirst ? -1 : 1));
      for (const timer of due) fire(timer);
      return { start, end: time };
    },
    nextSampleDue: () => timers.find((timer) => timer.name === "sample")!.due,
    get time() { return time; },
  };
}

/** The production settings on a simulated clock: a stall `offset` ms after a sample. */
function stallAfterSample(offset: number, length: number, sampleFirst: boolean) {
  const sim = loop();
  watch = createEventLoopStalls(sim.now, { clock: sim.clock, every: sim.every });
  sim.runUntil(sim.time + 3 * SAMPLE_MS);
  const lastSample = sim.nextSampleDue() - SAMPLE_MS;
  sim.runUntil(lastSample + offset);
  const { start, end } = sim.stall(length, sampleFirst);
  sim.runUntil(end + 2 * SAMPLE_MS);
  const seen = watch.stalledBetween(start, end);
  watch.close();
  watch = null;
  return seen;
}

describe("this process's event loop stalls, at the production settings", () => {
  it("sees a stall that starts just after a sample, whichever overdue timer runs first", () => {
    for (const sampleFirst of [true, false]) {
      for (const offset of [1, 10, 100, 250, 499, 500, 501]) {
        expect(stallAfterSample(offset, STALL_MS, sampleFirst), `offset ${offset}, sample first ${sampleFirst}`).toBe(true);
        expect(stallAfterSample(offset, 4_000, sampleFirst), `4 s at offset ${offset}, sample first ${sampleFirst}`).toBe(true);
      }
    }
  });

  it("sees a stall that straddles a sample, when the sample runs before the tick it held up and when after", () => {
    for (const sampleFirst of [true, false]) {
      for (const before of [1, 100, 1_000, 1_999]) {
        expect(stallAfterSample(SAMPLE_MS - before, STALL_MS, sampleFirst), `${before} ms before the sample, sample first ${sampleFirst}`).toBe(true);
        expect(stallAfterSample(SAMPLE_MS - before, 7_000, sampleFirst), `7 s from ${before} ms before, sample first ${sampleFirst}`).toBe(true);
      }
    }
  });

  it("sees a stall at any offset in the sample", () => {
    for (let offset = 0; offset < SAMPLE_MS; offset += 37) {
      for (const sampleFirst of [true, false]) expect(stallAfterSample(offset, STALL_MS, sampleFirst), `offset ${offset}`).toBe(true);
    }
  });

  it("never takes a quiet loop, or a hold-up well under the stall, for a stall", () => {
    for (let offset = 0; offset < SAMPLE_MS; offset += 251) {
      for (const sampleFirst of [true, false]) expect(stallAfterSample(offset, STALL_MS - LOOP_TIMER_MS - 1, sampleFirst), `offset ${offset}`).toBe(false);
    }
    const sim = loop();
    watch = createEventLoopStalls(sim.now, { clock: sim.clock, every: sim.every });
    const from = sim.time;
    sim.runUntil(from + 60 * SAMPLE_MS);
    expect(watch.stalledBetween(from, sim.time)).toBe(false);
  });

  it("ticks a couple of times a second, well inside a stall and a sample", () => {
    // Each tick wakes an idle server; a gap only reads as a stall past the threshold, so the tick must stay under it, and
    // a sample must hold several ticks.
    expect(LOOP_TIMER_MS).toBeGreaterThanOrEqual(250);
    expect(STALL_MS / LOOP_TIMER_MS).toBeGreaterThanOrEqual(4);
    expect(SAMPLE_MS / LOOP_TIMER_MS).toBeGreaterThanOrEqual(10);
  });
});

describe("this process's event loop stalls, on real timers", () => {
  it("are seen in the window they fall in, and not in one that ended before them", async () => {
    // The production ratios, scaled down: a sample holds ten ticks.
    watch = createEventLoopStalls(Date.now, { tickMs: 100, sampleMs: 1_000, stallMs: 1_000 });
    await pause(1_500);
    const before = Date.now();
    // Held for well over the threshold: a margin of more than a second.
    for (const end = Date.now() + 2_500; Date.now() < end;) { /* the stall */ }
    await pause(2_200);
    expect(watch.stalledBetween(before, Date.now())).toBe(true);
    expect(watch.stalledBetween(before - 10_000, before - 5_000)).toBe(false);
  });
});
