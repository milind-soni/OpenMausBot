import { describe, expect, it } from "vitest";

import { hookMatches } from "./claude-hook-matcher.ts";

const tool = (name: string) => ({ tool_name: name });

describe("hookMatches", () => {
  it("matches every event with no matcher, an empty one or a star", () => {
    for (const matcher of [undefined, "", "*"]) expect(hookMatches("PostToolUse", matcher, tool("Read"))).toBe(true);
  });

  it("compares plain names exactly, alone or in a list", () => {
    expect(hookMatches("PostToolUseFailure", "Bash", tool("Bash"))).toBe(true);
    expect(hookMatches("PostToolUseFailure", "Bash", tool("BashOutput"))).toBe(false);
    expect(hookMatches("PostToolUse", "Edit, Write", tool("Write"))).toBe(true);
    expect(hookMatches("PostToolUse", "Edit|Write", tool("Edit"))).toBe(true);
    expect(hookMatches("PostToolUse", "Edit, Write", tool("NotebookEdit"))).toBe(false);
  });

  it("tests any other matcher as an unanchored regular expression", () => {
    expect(hookMatches("PostToolUse", "Edit.*", tool("NotebookEdit"))).toBe(true);
    expect(hookMatches("PostToolUse", "^Notebook", tool("NotebookEdit"))).toBe(true);
    expect(hookMatches("PostToolUse", "^Edit$", tool("NotebookEdit"))).toBe(false);
  });

  it("reads a session's source and a compaction's trigger", () => {
    expect(hookMatches("SessionStart", "compact", { source: "compact" })).toBe(true);
    expect(hookMatches("SessionStart", "compact", { source: "startup" })).toBe(false);
    expect(hookMatches("PreCompact", "auto", { trigger: "manual" })).toBe(false);
  });

  it("skips a hook whose expression does not compile", () => {
    expect(hookMatches("PostToolUse", "[", tool("Bash"))).toBe(false);
  });

  it("ignores a matcher on an event that has none", () => {
    expect(hookMatches("Stop", "Bash", { stop_hook_active: false })).toBe(true);
  });
});
