import { describe, expect, it } from "vitest";

import { hookMatches } from "./claude-hook-matcher.ts";

describe("hookMatches", () => {
  it("matches every event with no matcher, an empty one or a star", () => {
    for (const matcher of [undefined, "", "*"]) expect(hookMatches(matcher, "Read")).toBe(true);
  });

  it("compares plain names exactly, alone or in a list", () => {
    expect(hookMatches("Bash", "Bash")).toBe(true);
    expect(hookMatches("Bash", "BashOutput")).toBe(false);
    expect(hookMatches("compact", "startup")).toBe(false);
    expect(hookMatches("Edit, Write", "Write")).toBe(true);
    expect(hookMatches("Edit|Write", "Edit")).toBe(true);
    expect(hookMatches("Edit, Write", "NotebookEdit")).toBe(false);
  });

  it("tests any other matcher as an unanchored regular expression", () => {
    expect(hookMatches("Edit.*", "NotebookEdit")).toBe(true);
    expect(hookMatches("^Notebook", "NotebookEdit")).toBe(true);
    expect(hookMatches("^Edit$", "NotebookEdit")).toBe(false);
  });
});
