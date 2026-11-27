import { describe, expect, it } from "vitest";

import { createStallTicker } from "./stall-ticker.ts";

const options = { thresholdMs: 10_000, repeatMs: 60_000, perStall: 5, recordsPerHour: 30, profilesPerHour: 5 };

/** Ticks once a second from `from` to `to` (ms), the heartbeat at `beat(now)`; the times a record was due. */
function run(ticker: ReturnType<typeof createStallTicker>, from: number, to: number, beat: (now: number) => number): number[] {
  const due: number[] = [];
  for (let now = from; now <= to; now += 1_000) if (ticker.tick(now, beat(now))) due.push(now);
  return due;
}

describe("stall ticker", () => {
  it("records once the heartbeat is old enough, again each minute while it stays old, five times a stall at most", () => {
    const ticker = createStallTicker(options);
    expect(run(ticker, 0, 5_000, (now) => now)).toEqual([]);
    // The main thread stops beating at 5 s.
    const due = run(ticker, 6_000, 400_000, () => 5_000);
    expect(due).toEqual([15_000, 75_000, 135_000, 195_000, 255_000]);
    expect(ticker.age(15_000, 5_000)).toBe(10_000);
  });

  it("starts a new stall's count once the main thread has beaten again", () => {
    const ticker = createStallTicker(options);
    expect(run(ticker, 0, 20_000, () => 0)).toEqual([10_000]);
    expect(run(ticker, 21_000, 25_000, (now) => now)).toEqual([]);
    // A second stall: a new count, but records stay at least a minute apart whatever the stall.
    expect(run(ticker, 26_000, 100_000, () => 25_000)).toEqual([70_000]);
  });

  it("takes no more than the hour's records across stalls", () => {
    const ticker = createStallTicker({ ...options, recordsPerHour: 3, perStall: 1 });
    let due: number[] = [];
    for (let stall = 0; stall < 6; stall++) {
      const start = stall * 120_000;
      run(ticker, start, start + 5_000, (now) => now);
      due = due.concat(run(ticker, start + 6_000, start + 100_000, () => start + 5_000));
    }
    expect(due).toHaveLength(3);
    // An hour after the first, there is room again.
    run(ticker, 3_700_000, 3_705_000, (now) => now);
    expect(run(ticker, 3_706_000, 3_720_000, () => 3_705_000)).toEqual([3_715_000]);
  });

  it("takes no more than five profiles in any hour", () => {
    const ticker = createStallTicker(options);
    const allowed = [0, 1, 2, 3, 4, 5, 6].map((minute) => ticker.mayProfile(minute * 60_000));
    expect(allowed).toEqual([true, true, true, true, true, false, false]);
    expect(ticker.mayProfile(3_600_001)).toBe(true);
  });

  it("counts a pause of the whole process (a late tick of its own after a fresh heartbeat) as no stall", () => {
    const ticker = createStallTicker(options);
    expect(run(ticker, 0, 5_000, (now) => now)).toEqual([]);
    // Stopped for 30 s: the next tick comes 31 s later and the heartbeat is as old; then the main thread beats again.
    expect(ticker.tick(36_000, 5_000)).toBe(false);
    expect(run(ticker, 37_000, 60_000, (now) => now)).toEqual([]);
    // And measured from the resume: a main thread that is stuck after it is recorded 10 s on.
    expect(run(ticker, 61_000, 75_000, () => 60_500)).toEqual([71_000]);
  });

  it("still records when its own ticks come late while the main thread is already stuck (a starved machine)", () => {
    const ticker = createStallTicker(options);
    run(ticker, 0, 5_000, (now) => now);
    // The main thread stops at 5 s; ticks then come 3 s apart.
    const due: number[] = [];
    for (let now = 6_000; now <= 30_000; now += 3_000) if (ticker.tick(now, 5_000)) due.push(now);
    expect(due.length).toBe(1);
  });
});
