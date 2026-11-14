import { describe, expect, it, vi } from "vitest";

import { batchSaves, saveSoon } from "./save-batch.ts";

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
