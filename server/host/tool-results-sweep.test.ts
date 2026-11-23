import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { spillToolResult } from "../tool-result-spill.ts";
import { MAX_AGE_MS, sweepLine, sweepToolResults, toolResultsSweepMode } from "./tool-results-sweep.ts";

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

  it("follows no link: a linked folder or a linked file stays, and so does what it points at", async () => {
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

  it("a root that is a link, or missing, is left alone", async () => {
    const outside = join(base, "outside");
    const target = put(join(outside, "thread-x", "old.txt"), 10 * MAX_AGE_MS);
    const linked = join(base, "linked-root");
    symlinkSync(outside, linked);
    expect((await sweepToolResults({ root: linked, mode: "on", now: () => NOW })).files).toBe(0);
    expect(existsSync(target)).toBe(true);
    expect((await sweepToolResults({ root: join(base, "missing"), mode: "on", now: () => NOW })).files).toBe(0);
  });

  it("stops for a move or backup", async () => {
    const files = seed();
    const result = await sweepToolResults({ root, mode: "on", paused: () => true, now: () => NOW });
    expect(result.stopped).toBe(true);
    expect(existsSync(files.oldHook)).toBe(true);
  });
});
