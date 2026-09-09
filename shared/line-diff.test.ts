import { describe, expect, it } from "vitest";

import { lineDiff } from "./line-diff";

describe("lineDiff", () => {
  it("is empty for identical text", () => {
    expect(lineDiff("a\nb", "a\nb")).toEqual([]);
    expect(lineDiff("", "")).toEqual([]);
  });

  it("bounds work for valid instructions containing thousands of short lines", () => {
    const before = "a\n".repeat(11_999);
    const after = "b\n".repeat(11_999);
    const diff = lineDiff(before, after);
    expect(diff).toHaveLength(24_000);
    expect(diff[0]).toBe("-a");
    expect(diff[12_000]).toBe("+b");
  });

  it("marks added, removed, and kept lines in order", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc\nd")).toEqual([" a", "-b", "+B", " c", "+d"]);
  });

  it("handles a fresh soul (all added) and a cleared soul (all removed)", () => {
    expect(lineDiff("", "one\ntwo")).toEqual(["+one", "+two"]);
    expect(lineDiff("one", "")).toEqual(["-one"]);
  });
});
