import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHistogram, type IntervalHistogram } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";

import { writeFileAtomic } from "../atomic.ts";
import { countAtLeast, createLoopStalls, loopStallCounts, markRequestArrival, REPORTED_WORST_MINUTES, requestArrivedBefore, STALL_RESOLUTION_MS, stallStats, timeBlocking } from "./loop-stalls.ts";
import { PERF_HEALTH_MAX_BYTES, perfHealth, stallLines } from "./perf-report.ts";

const tally = { n: 0, ms: 0, maxMs: 0 };
const minute = (count: number, points: Array<[number, number]>) => ({ count, points, maxMs: points.at(-1)![1], saves: tally, runtimeReads: tally, pauses: tally });

describe("loop stall percentiles", () => {
  it("weighs each minute by its samples, so one bad minute shows in the hour's tail and not its middle", () => {
    const quiet = minute(3000, [[0, 0.1], [60, 0.2], [99, 0.5], [100, 1]]);
    const bad = minute(30, [[0, 0.1], [50, 0.3], [90, 900], [100, 2500]]);
    const hour = stallStats([quiet, quiet, bad])!;
    expect(hour.p50).toBe(0.2);
    expect(hour.max).toBe(2500);
    expect(hour.over1s).toBe(3);
    expect(hour.over100ms).toBe(15);
    expect(stallStats([bad])).toMatchObject({ p50: 0.3, p95: 2500, p99: 2500, max: 2500 });
    expect(stallStats([])).toBeNull();
  });
});

describe("the loop stall recorder", () => {
  it("sees a stall the once-a-minute sampler would miss, and counts whole-file saves", async () => {
    const stalls = createLoopStalls({ minuteMs: 60_000 });
    const dir = mkdtempSync(join(tmpdir(), "loop-stalls-"));
    stalls.start();
    try {
      // Several of the histogram's own firings on each side of the stall, so the stall is one sample among many.
      await delay(5 * STALL_RESOLUTION_MS);
      const before = stalls.report().saves.m1.n;
      writeFileAtomic(join(dir, "a.json"), "{}");
      timeBlocking("runtimeReads", () => { const until = Date.now() + 300; while (Date.now() < until) { /* the stall */ } });
      await delay(5 * STALL_RESOLUTION_MS);
      const report = stalls.report();
      // A stall reads as its length less up to one firing interval, never less.
      expect(report.m1!.max).toBeGreaterThanOrEqual(300 - STALL_RESOLUTION_MS);
      expect(report.m1!.over100ms).toBeGreaterThanOrEqual(1);
      // One stall does not set the median; the rest is timer slop, a few ms late on a busy runner (Windows ticks every 15.6 ms).
      expect(report.m1!.p50).toBeLessThan(50);
      expect(report.h1!.max).toBe(report.m1!.max);
      expect(report.saves.m1.n).toBe(before + 1);
      expect(report.runtimeReads.m1).toMatchObject({ n: 1 });
      expect(report.runtimeReads.m1.maxMs).toBeGreaterThanOrEqual(290);
      stalls.roll();
      const rolled = stalls.report();
      expect(rolled.m1!.max).toBe(report.m1!.max);
      expect(rolled.runtimeReads.h1.n).toBe(1);
      expect(stallLines(rolled)[0]).toMatch(/^Event loop stalls, measured all the time: last minute p50 .* max \d/);
    } finally {
      stalls.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fires its timer at most ten times a second, so an idle server is not woken fifty times a second", () => {
    // At 20 ms the firings were most of an idle Cloud's CPU; a stall still reads within one interval of its length.
    expect(STALL_RESOLUTION_MS).toBeGreaterThanOrEqual(100);
    expect(STALL_RESOLUTION_MS).toBeLessThan(1_000);
  });

  it("counts a gap the loop only waited through as a sleep or a pause, and one it worked through as a stall", () => {
    const delays: number[] = [];
    const histogram = {
      get count() { return delays.length; },
      get max() { return delays.length ? (Math.max(...delays) + STALL_RESOLUTION_MS) * 1e6 : 0; },
      get percentiles() { return new Map(delays.length ? [[0, (STALL_RESOLUTION_MS + 0.1) * 1e6], [99, (STALL_RESOLUTION_MS + 0.1) * 1e6], [100, (Math.max(...delays) + STALL_RESOLUTION_MS) * 1e6]] : []); },
      reset() { delays.length = 0; }, enable: () => true, disable: () => true,
    } as unknown as IntervalHistogram;
    let mono = 0, waited: number | null = 0;
    const resumed: number[] = [];
    const stalls = createLoopStalls({ histogram, monotonic: () => mono, idle: () => waited, resumed: (ms) => resumed.push(ms) });
    const minute = (gapMs: number, workedMs: number, rollAfter = true) => {
      delays.push(0.1, 0.1, gapMs);
      mono += 60_000 + gapMs;
      if (waited !== null) waited += 60_000 + gapMs - workedMs;
      if (rollAfter) stalls.roll();
    };

    const hour = 3_600_000;
    minute(hour, 100);
    expect(resumed).toEqual([hour]);
    expect(stalls.report()).toMatchObject({ m1: null, h1: null, pauses: { h1: { n: 1, ms: hour, maxMs: hour } } });

    minute(5_000, 5_100);
    expect(resumed).toEqual([hour]);
    expect(stalls.report()).toMatchObject({ m1: { max: 5_000 }, h1: { max: 5_000 }, pauses: { m1: { n: 0 }, h1: { n: 1 } } });

    minute(10 * 60_000, 50, false);
    expect(stalls.report()).toMatchObject({ h1: { max: 5_000 }, pauses: { h1: { n: 2, maxMs: hour } } });
    stalls.roll();
    expect(resumed).toEqual([hour, 10 * 60_000]);
    expect(stallLines(stalls.report())[3]).toMatch(/^ {2}Sleeps or pauses, left out of the stalls: last minute 0 .*; last hour 2 /);

    mono += 10_000;
    stalls.roll();
    minute(10_000, 0);
    expect(resumed).toHaveLength(2);
    expect(stalls.report().m1).toMatchObject({ max: 10_000 });

    waited = null;
    minute(hour, 100);
    expect(resumed).toHaveLength(2);
    expect(stalls.report().h1).toMatchObject({ max: hour });
  });

  it("counts stalls of a second or more since start for the health report, and the worst of the last 15 minutes; never a pause", () => {
    // A histogram as Node fills it: 600 firings a minute at 100 ms, a stall being one late firing.
    let count = 0, samples: Array<[number, number]> = [];
    const histogram = {
      get count() { return count; },
      get max() { return count ? (Math.max(...samples.map(([, ms]) => ms)) + STALL_RESOLUTION_MS) * 1e6 : 0; },
      get percentiles() { return new Map(samples.map(([percentile, ms]) => [percentile, (ms + STALL_RESOLUTION_MS) * 1e6])); },
      reset() { count = 0; samples = []; }, enable: () => true, disable: () => true,
    } as unknown as IntervalHistogram;
    let mono = 0, waited = 0;
    const stalls = createLoopStalls({ histogram, monotonic: () => mono, idle: () => waited });
    /** A minute whose loop worked most of the time, with these late firings among 600. */
    const minute = (late: number[]) => {
      count = 600;
      const sorted = [...late].sort((a, b) => a - b);
      samples = [[0, 0.1], [100 * (1 - late.length / 600), 0.1], ...sorted.map((ms, index) => [100 * (1 - (late.length - 1 - index) / 600), ms] as [number, number])];
      mono += 60_000; waited += 5_000;
      stalls.roll();
    };
    minute([5_000]); minute([]); minute([1_500, 2_500, 700]);
    expect(stalls.counts()).toEqual({ n: 3, worstMs: 5_000 });
    for (let quiet = 0; quiet < REPORTED_WORST_MINUTES; quiet++) minute([]);
    // The worst ages out of its 15 minutes; the count since start stays (the Admin takes each read's increase).
    expect(stalls.counts()).toEqual({ n: 3, worstMs: 0 });
    // A computer that slept (the loop waited through the gap) is no stall.
    count = 3; samples = [[0, 0.1], [99, 0.1], [100, 3_600_000]];
    mono += 60_000 + 3_600_000; waited += 60_000 + 3_600_000 - 50;
    stalls.roll();
    expect(stalls.counts()).toEqual({ n: 3, worstMs: 0 });
    // The started recorder answers the health report's read; none before start or after stop.
    expect(loopStallCounts()).toBeNull();
    stalls.start();
    expect(loopStallCounts()).toEqual({ n: 3, worstMs: 0 });
    stalls.stop();
    expect(loopStallCounts()).toBeNull();
  });

  it("counts a real histogram's stalls exactly, not from its sparse percentile ranks, and lets the worst age by time through a long pause", () => {
    const ms = (value: number) => Math.round((value + STALL_RESOLUTION_MS) * 1e6);
    const real = createHistogram();
    for (let i = 0; i < 495; i++) real.record(ms(0.2));
    for (let i = 0; i < 5; i++) real.record(ms(1_500));
    // Node's sparse ranks put the last short delay at 98.4375%, which read as eight stalls; the histogram itself says five.
    expect(countAtLeast(real, ms(1_000))).toBe(5);
    expect(countAtLeast(real, ms(2_000))).toBe(0);
    const histogram = Object.assign(real, { enable: () => true, disable: () => true }) as unknown as IntervalHistogram;
    let mono = 0, waited = 0;
    const stalls = createLoopStalls({ histogram, monotonic: () => mono, idle: () => waited });
    mono += 60_000; waited += 5_000;
    stalls.roll();
    expect(stalls.counts()).toEqual({ n: 5, worstMs: 1_500 });
    // The process sleeps an hour: one roll, but the stall is an hour old and out of the last 15 minutes.
    real.record(ms(0.2));
    mono += 3_600_000; waited += 3_600_000;
    stalls.roll();
    expect(stalls.counts()).toEqual({ n: 5, worstMs: 0 });
  });

  it("starts a message's wait when its request arrived, only for that request and only if recent", async () => {
    expect(requestArrivedBefore(Date.now())).toBeUndefined();
    await (async () => {
      markRequestArrival(1_000);
      await Promise.resolve();
      expect(requestArrivedBefore(3_500)).toBe(1_000);
      expect(requestArrivedBefore(500)).toBeUndefined();
      expect(requestArrivedBefore(1_000 + 120_000)).toBeUndefined();
    })();
  });

  it("fits the health report's budget with the rest of the timings, and holds numbers only", () => {
    const stalls = createLoopStalls();
    const report = stalls.report();
    const body = perfHealth({ hour: { turns: 0, failed: 0, phases: {}, setup: {}, slow: [], partial: false }, day: { turns: 0, failed: 0, slow: [], phases: {}, setup: {}, tools: [], retries: { n: 0, turns: 0, backoffMs: 0, why: {} }, limits: {}, failovers: 0 } as never,
      live: [], limits: null, process: null, stalls: report });
    expect(JSON.stringify(body).length).toBeLessThanOrEqual(PERF_HEALTH_MAX_BYTES);
    expect(body.stalls).toEqual(report);
    const strings: string[] = [];
    JSON.stringify(report, (_key, value) => { if (typeof value === "string") strings.push(value); return value; });
    expect(strings).toEqual([]);
  });
});
