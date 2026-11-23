import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { spillToolResult } from "../tool-result-spill.ts";
import { FIRST_PASS_MS, MAX_AGE_MS, STAMP_FILE, schedulePasses, startToolResultsSweep, sweepLine, sweepToolResults, toolResultsSweepMode } from "./tool-results-sweep.ts";

const NOW = Date.parse("2026-11-23T12:00:00Z");
let base: string, root: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "tool-results-sweep-"));
  root = join(base, "tool-results");
  mkdirSync(root);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

function put(path: string, ageMs: number, bytes = 1_000): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "x".repeat(bytes));
  utimesSync(path, new Date(NOW - ageMs), new Date(NOW - ageMs));
  return path;
}

function seed() {
  return {
    oldHook: put(join(root, "thread-a", `${"a".repeat(64)}.txt`), MAX_AGE_MS + 60_000, 4_000),
    oldGate: put(join(root, "thread-b", "1700000000000-42-0-search.json"), 3 * MAX_AGE_MS, 6_000),
    newHook: put(join(root, "thread-a", `${"b".repeat(64)}.txt`), MAX_AGE_MS - 60_000),
    newGate: put(join(root, "thread-b", "1700000000001-42-1-search.json"), 60_000),
    topLevel: put(join(root, "stray.txt"), 10 * MAX_AGE_MS),
    nested: put(join(root, "thread-a", "deeper", "old.txt"), 10 * MAX_AGE_MS),
  };
}

describe("the tool results' sweep", () => {
  it("is off unless set", () => {
    expect(toolResultsSweepMode({})).toBe("off");
    expect(toolResultsSweepMode({ OMB_TOOL_RESULTS_SWEEP: "please" })).toBe("off");
    expect(toolResultsSweepMode({ OMB_TOOL_RESULTS_SWEEP: "dry-run" })).toBe("report");
    expect(toolResultsSweepMode({ OMB_TOOL_RESULTS_SWEEP: "on" })).toBe("on");
  });

  it("removes every conversation's results older than a day, keeps newer ones and every folder", async () => {
    const files = seed();
    const result = await sweepToolResults({ root, mode: "on", now: () => NOW });
    expect(result).toMatchObject({ folders: 2, files: 2, bytes: 10_000, stopped: false });
    expect(existsSync(files.oldHook)).toBe(false);
    expect(existsSync(files.oldGate)).toBe(false);
    for (const file of [files.newHook, files.newGate, files.topLevel, files.nested]) expect(existsSync(file), file).toBe(true);
    expect(readdirSync(root).sort()).toEqual(["stray.txt", "thread-a", "thread-b"]);
    expect(sweepLine(result)).toContain("freed 0.0 MB");
  });

  it("leaves a folder the hook writes into again right after", async () => {
    const files = seed();
    rmSync(files.newHook);
    await sweepToolResults({ root, mode: "on", now: () => NOW });
    expect(readdirSync(join(root, "thread-a"))).toEqual(["deeper"]);
    expect(spillToolResult(join(root, "thread-a"), "thread-a:turn:tool", "output", 100)).toBe(true);
    expect(readdirSync(join(root, "thread-a"))).toHaveLength(2);
  });

  it("a report counts the same and changes nothing", async () => {
    const files = seed();
    const report = await sweepToolResults({ root, mode: "report", now: () => NOW });
    for (const file of Object.values(files)) expect(existsSync(file)).toBe(true);
    const result = await sweepToolResults({ root, mode: "on", now: () => NOW });
    expect([report.files, report.bytes]).toEqual([result.files, result.bytes]);
    expect(sweepLine(report)).toContain("would free");
  });

  // Windows makes a link only with a privilege CI's runners lack; Cloud homes, where this runs, are Linux.
  it.skipIf(process.platform === "win32")("follows no link: a linked folder or a linked file stays, and so does what it points at", async () => {
    seed();
    const outside = join(base, "outside");
    const target = put(join(outside, "precious.txt"), 10 * MAX_AGE_MS);
    symlinkSync(outside, join(root, "thread-link"));
    symlinkSync(target, join(root, "thread-a", "link.txt"));
    await sweepToolResults({ root, mode: "on", now: () => NOW });
    expect(existsSync(target)).toBe(true);
    expect(lstatSync(join(root, "thread-a", "link.txt")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(root, "thread-link")).isSymbolicLink()).toBe(true);
  });

  it.skipIf(process.platform === "win32")("a root that is a link, or missing, is left alone", async () => {
    const outside = join(base, "outside");
    const target = put(join(outside, "thread-x", "old.txt"), 10 * MAX_AGE_MS);
    const linked = join(base, "linked-root");
    symlinkSync(outside, linked);
    expect((await sweepToolResults({ root: linked, mode: "on", now: () => NOW })).files).toBe(0);
    expect(existsSync(target)).toBe(true);
    expect((await sweepToolResults({ root: join(base, "missing"), mode: "on", now: () => NOW })).files).toBe(0);
  });

  it("over the cap removes the hook's outputs under a day old too, oldest first, never one under an hour, never a gate's result", async () => {
    const files = seed();
    const hook = (h: string) => join(root, "thread-c", `${h.repeat(64)}.txt`);
    const hours = ([["c", 20], ["d", 10], ["e", 2]] as const).map(([name, h]) => put(hook(name), h * 60 * 60_000, 3_000));
    const minutes = put(hook("f"), 30 * 60_000, 3_000);
    const gate = put(join(root, "thread-c", "1700000000002-42-2-search.json"), 20 * 60 * 60_000, 3_000);
    // Under a day: newHook and newGate 1 KB each, four hook outputs and one gate result at 3 KB, 17 KB against 8 KB.
    const result = await sweepToolResults({ root, mode: "on", cap: 8_000, now: () => NOW });
    expect(result.overCap).toBe(4);
    for (const file of [files.newHook, ...hours]) expect(existsSync(file), file).toBe(false);
    for (const file of [minutes, gate, files.newGate]) expect(existsSync(file), file).toBe(true);
    const tight = await sweepToolResults({ root, mode: "on", cap: 0, now: () => NOW });
    expect(tight.overCap).toBe(0);
    for (const file of [minutes, gate, files.newGate]) expect(existsSync(file), file).toBe(true);
  });

  it("removes nothing while a turn runs, and goes on once none does", async () => {
    const files = seed();
    const busy = await sweepToolResults({ root, mode: "on", turnsRunning: () => true, turnWaitMs: 0, now: () => NOW });
    expect(busy.stopped).toBe(true);
    expect(existsSync(files.oldHook)).toBe(true);
    let checks = 0;
    const later = await sweepToolResults({ root, mode: "on", turnsRunning: () => checks++ < 1, turnWaitMs: 60_000, now: () => NOW });
    expect(later.files).toBe(2);
  }, 30_000);

  it("schedules a pass soon after start, or when due by the last whole pass", async () => {
    vi.useFakeTimers();
    try {
      const stamp = join(base, "cache", "stamp.json");
      let clock = NOW;
      const passes: number[] = [];
      schedulePasses(stamp, 6 * 60 * 60_000, async () => (passes.push(clock), true), () => clock);
      clock += FIRST_PASS_MS;
      await vi.advanceTimersByTimeAsync(FIRST_PASS_MS);
      expect(passes).toHaveLength(1);
      vi.clearAllTimers();
      clock += 60 * 60_000;
      // Read at the first timer, the stamp says five hours are left.
      schedulePasses(stamp, 6 * 60 * 60_000, async () => (passes.push(clock), true), () => clock);
      await vi.advanceTimersByTimeAsync(FIRST_PASS_MS + 4 * 60 * 60_000);
      expect(passes).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(passes).toHaveLength(2);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("a frozen home's pass removes nothing and writes no stamp", async () => {
    vi.useFakeTimers();
    try {
      const files = seed();
      const dataDir = join(base, "data");
      expect(startToolResultsSweep({ cloudHome: true, env: { OMB_TOOL_RESULTS_SWEEP: "on" }, dataDir, root, paused: () => true, log: () => {} })).toBe(true);
      await vi.advanceTimersByTimeAsync(FIRST_PASS_MS);
      expect(existsSync(files.oldHook)).toBe(true);
      expect(existsSync(join(dataDir, STAMP_FILE))).toBe(false);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("stops for a move or backup", async () => {
    const files = seed();
    const result = await sweepToolResults({ root, mode: "on", paused: () => true, now: () => NOW });
    expect(result.stopped).toBe(true);
    expect(existsSync(files.oldHook)).toBe(true);
  });
});
