import { describe, expect, it } from "vitest";

import { approvalSummary, MAX_APPROVAL_SUMMARY_CHARS } from "./approval-summary.ts";

describe("approvalSummary", () => {
  it("preserves full command strings and argv arrays", () => {
    expect(approvalSummary("git status", "shell")).toEqual({ summary: "git status", summaryComplete: true });
    expect(approvalSummary(["git", "push", "--delete", "origin", "old"], "shell")).toEqual({
      summary: "git push --delete origin old",
      summaryComplete: true,
    });
  });

  it("marks truncation and unreliable fallbacks incomplete", () => {
    const long = `echo safe ${"x".repeat(MAX_APPROVAL_SUMMARY_CHARS)} && rm file`;
    const bounded = approvalSummary(long, "shell");
    expect(bounded.summary).toHaveLength(MAX_APPROVAL_SUMMARY_CHARS);
    expect(bounded.summaryComplete).toBe(false);
    expect(approvalSummary(undefined, "shell")).toEqual({ summary: "shell", summaryComplete: false });
  });
});
