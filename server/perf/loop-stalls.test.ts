import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";

import { writeFileAtomic } from "../atomic.ts";
import { createLoopStalls, markRequestArrival, requestArrivedBefore, stallStats, timeBlocking } from "./loop-stalls.ts";
import { PERF_HEALTH_MAX_BYTES, perfHealth, stallLines } from "./perf-report.ts";

const tally = { n: 0, ms: 0, maxMs: 0 };
const minute = (count: number, points: Array<[number, number]>) => ({ count, points, maxMs: points.at(-1)![1], saves: tally, runtimeReads: tally });

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
      await delay(60);
      const before = stalls.report().saves.m1.n;
      writeFileAtomic(join(dir, "a.json"), "{}");
      timeBlocking("runtimeReads", () => { const until = Date.now() + 300; while (Date.now() < until) { /* the stall */ } });
      await delay(60);
      const report = stalls.report();
      expect(report.m1!.max).toBeGreaterThanOrEqual(250);
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
    const body = perfHealth({ hour: { turns: 0, failed: 0, phases: {}, slow: [], partial: false }, day: { turns: 0, failed: 0, slow: [], phases: {}, tools: [], retries: { n: 0, turns: 0, backoffMs: 0, why: {} }, limits: {}, failovers: 0 } as never,
      live: [], limits: null, process: null, stalls: report });
    expect(JSON.stringify(body).length).toBeLessThanOrEqual(PERF_HEALTH_MAX_BYTES);
    expect(body.stalls).toEqual(report);
    const strings: string[] = [];
    JSON.stringify(report, (_key, value) => { if (typeof value === "string") strings.push(value); return value; });
    expect(strings).toEqual([]);
  });
});
