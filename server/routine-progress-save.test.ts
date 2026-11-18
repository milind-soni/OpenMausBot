import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { RunProgressSave } from "./routine-progress-save.ts";

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "omb-progress-save-"));
  vi.useFakeTimers();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  rmSync(directory, { recursive: true, force: true });
});

it("retries a failed timed save when shutdown flushes pending progress", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const write = vi.fn().mockImplementationOnce(() => { throw new Error("disk unavailable"); });
  const progress = new RunProgressSave(() => join(directory, "routines.json"), write, 100);
  progress.soon();
  vi.advanceTimersByTime(100);
  expect(write).toHaveBeenCalledTimes(1);
  progress.flush();
  expect(write).toHaveBeenCalledTimes(2);
  progress.flush();
  expect(write).toHaveBeenCalledTimes(2);
});

it("keeps a failed flush pending for a later stop or backup", () => {
  const write = vi.fn().mockImplementationOnce(() => { throw new Error("disk unavailable"); });
  const progress = new RunProgressSave(() => join(directory, "routines.json"), write, 100);
  progress.soon();
  expect(() => progress.flush()).toThrow("disk unavailable");
  progress.flush();
  expect(write).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(100);
  expect(write).toHaveBeenCalledTimes(2);
});

it("a successful whole-file save clears progress pending after a failed write", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const write = vi.fn(() => { throw new Error("disk unavailable"); });
  const progress = new RunProgressSave(() => join(directory, "routines.json"), write, 100);
  progress.soon();
  vi.advanceTimersByTime(100);
  progress.written();
  expect(() => progress.flush()).not.toThrow();
  expect(write).toHaveBeenCalledTimes(1);
});

it("a removed progress directory is not recreated by a later flush", () => {
  const write = vi.fn();
  const progress = new RunProgressSave(() => join(directory, "routines.json"), write, 100);
  progress.soon();
  rmSync(directory, { recursive: true });
  vi.advanceTimersByTime(100);
  progress.flush();
  expect(write).not.toHaveBeenCalled();
});

it("does not recreate a directory removed after a timed save failed", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const file = join(directory, "routines.json");
  const write = vi.fn(() => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(file, JSON.stringify({ progress: "old data" }));
  }).mockImplementationOnce(() => { throw new Error("disk unavailable"); });
  const progress = new RunProgressSave(() => file, write, 100);
  progress.soon();
  vi.advanceTimersByTime(100);
  expect(write).toHaveBeenCalledTimes(1);
  rmSync(directory, { recursive: true });
  progress.flush();
  expect(existsSync(directory)).toBe(false);
  expect(write).toHaveBeenCalledTimes(1);
  // Removing the directory retired this pending state, even if a new data
  // directory is later created at the same path.
  mkdirSync(directory);
  progress.flush();
  expect(existsSync(file)).toBe(false);
});
