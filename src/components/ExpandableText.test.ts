import { describe, expect, it } from "vitest";

import { expandableTextClass, expandableTextIsLong, EXPANDABLE_TEXT_LIMIT } from "./ExpandableText";

describe("expandable question text", () => {
  it("leaves a short question alone", () => {
    expect(expandableTextIsLong("Which color?")).toBe(false);
  });

  it("treats a long question as expandable", () => {
    expect(expandableTextIsLong("x".repeat(EXPANDABLE_TEXT_LIMIT + 1))).toBe(true);
  });

  it("clamps only while collapsed", () => {
    expect(expandableTextClass(false)).toContain("line-clamp-4");
    const open = expandableTextClass(true);
    expect(open).not.toContain("line-clamp");
    expect(open).not.toContain("max-h");
    expect(open).not.toContain("overflow-hidden");
    expect(open).toContain("break-words");
  });
});
