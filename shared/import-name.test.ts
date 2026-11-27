import { describe, expect, it } from "vitest";

import { takeImportName } from "./import-name.ts";

const loneSurrogate = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

describe("takeImportName", () => {
  it("numbers a taken name and reserves the result", () => {
    const taken = new Set(["ada"]);
    expect(takeImportName("Ada", taken)).toBe("Ada 2");
    expect(takeImportName(" Ada ", taken)).toBe("Ada 3");
    expect(taken.has("ada 3")).toBe(true);
  });

  it("keeps the name within the limit", () => {
    const taken = new Set<string>();
    expect(takeImportName("a".repeat(70), taken, 60)).toHaveLength(60);
    expect(takeImportName("a".repeat(70), taken, 60)).toBe(`${"a".repeat(58)} 2`);
  });

  it("does not cut an emoji in half at the limit", () => {
    const taken = new Set<string>();
    const name = takeImportName(`${"a".repeat(59)}😀`, taken, 60);
    expect(name).toBe("a".repeat(59));
    expect(loneSurrogate.test(name)).toBe(false);
  });

  it("does not cut an emoji in half to make room for the number", () => {
    const taken = new Set<string>();
    const first = takeImportName(`${"a".repeat(57)}😀b`, taken, 60);
    const second = takeImportName(`${"a".repeat(57)}😀b`, taken, 60);
    expect(first).toBe(`${"a".repeat(57)}😀b`);
    expect(second).toBe(`${"a".repeat(57)} 2`);
    expect(loneSurrogate.test(second)).toBe(false);
  });
});
