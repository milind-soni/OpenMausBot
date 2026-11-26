import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { batchSaves, flushLaterSaves, SAVE_LATER_MAX_MS, saveLater, saveLaterDelayMs, saveSoon, supersedeLaterSave, waitingSaves } from "./save-batch.ts";

describe("batchSaves", () => {
  it("writes at once outside a batch, and once per file when the outermost batch returns", () => {
    const writes: string[] = [];
    const a = {}, b = {};
    saveSoon(a, () => writes.push("a0"));
    expect(writes).toEqual(["a0"]);
    batchSaves(() => {
      saveSoon(a, () => writes.push("a1"));
      batchSaves(() => saveSoon(b, () => writes.push("b1")));
      saveSoon(a, () => writes.push("a2"));
      expect(writes).toEqual(["a0"]);
    });
    expect(writes).toEqual(["a0", "a2", "b1"]);
  });

  it("writes what was asked for when the batch throws, and a failed write never stops the others", () => {
    const writes: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => batchSaves(() => {
      saveSoon({}, () => { throw new Error("disk full"); });
      saveSoon({}, () => writes.push("b"));
      throw new Error("listener");
    })).toThrow("listener");
    expect(writes).toEqual(["b"]);
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("hands back what the batch returned", () => {
    expect(batchSaves(() => 42)).toBe(42);
  });
});

describe("saveLater", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { flushLaterSaves(); vi.useRealTimers(); });

  it("writes once for every change asked for within the delay, across passes of the event loop", async () => {
    const writes: string[] = [];
    saveLater("a", () => writes.push("a1"));
    await vi.advanceTimersByTimeAsync(10);
    saveLater("a", () => writes.push("a2"));
    batchSaves(() => saveLater("a", () => writes.push("a3")));
    saveLater("b", () => writes.push("b1"));
    expect(writes).toEqual([]);
    expect(waitingSaves()).toBe(2);
    await vi.advanceTimersByTimeAsync(saveLaterDelayMs());
    expect(writes).toEqual(["a3", "b1"]);
    expect(waitingSaves()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(writes).toEqual(["a3", "b1"]);
  });

  it("counts the delay from the first change still waiting, so a steady stream of changes cannot put the write off", async () => {
    const writes: number[] = [];
    const delay = saveLaterDelayMs();
    for (let i = 0; i < 10; i++) {
      saveLater("a", () => writes.push(i));
      await vi.advanceTimersByTimeAsync(delay / 5);
    }
    expect(writes.length).toBeGreaterThanOrEqual(1);
    expect(delay).toBeLessThanOrEqual(SAVE_LATER_MAX_MS);
  });

  it("writes everything waiting at once when flushed, and nothing twice", async () => {
    const writes: string[] = [];
    saveLater("a", () => writes.push("a"));
    saveLater("b", () => writes.push("b"));
    flushLaterSaves();
    expect(writes).toEqual(["a", "b"]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(writes).toEqual(["a", "b"]);
  });

  it("drops a waiting write once the file was written whole another way", async () => {
    const writes: string[] = [];
    saveLater("a", () => writes.push("a"));
    supersedeLaterSave("a");
    await vi.advanceTimersByTimeAsync(5_000);
    flushLaterSaves();
    expect(writes).toEqual([]);
  });

  it("preserves a newer write queued while the current flush is in progress", () => {
    const writes: string[] = [];
    saveLater("a", () => {
      writes.push("a");
      saveLater("b", () => writes.push("b-current"));
    });
    saveLater("b", () => writes.push("b-stale"));
    flushLaterSaves();
    expect(writes).toEqual(["a"]);
    expect(waitingSaves()).toBe(1);
    flushLaterSaves();
    expect(writes).toEqual(["a", "b-current"]);
    expect(waitingSaves()).toBe(0);
  });

  it("keeps a failed write waiting and tries it again", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = true;
    const writes: string[] = [];
    saveLater("a", () => { if (fail) throw new Error("disk full"); writes.push("a"); });
    saveLater("b", () => writes.push("b"));
    await vi.advanceTimersByTimeAsync(saveLaterDelayMs());
    expect(writes).toEqual(["b"]);
    expect(waitingSaves()).toBe(1);
    fail = false;
    await vi.advanceTimersByTimeAsync(SAVE_LATER_MAX_MS);
    expect(writes).toEqual(["b", "a"]);
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });
});
