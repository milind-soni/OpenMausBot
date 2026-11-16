import { describe, expect, it } from "vitest";
import { taskSummary } from "./taskSummary";

describe("taskSummary", () => {
  it("drops frontmatter, a repeated title heading and Markdown punctuation", () => {
    const desc = "---\nstatus: todo\ncreated: 2026-09-24\n---\n\n# Sign installers\n\nSplit out of the **pre-release** audit. See `docs/x.md` and [the plan](a.md).\n\n- [ ] one\n- two";
    expect(taskSummary(desc, "Sign installers")).toBe("Split out of the pre-release audit. See docs/x.md and the plan. one two");
  });
  it("keeps ordinary text and headings that differ from the title", () => {
    expect(taskSummary("Plain text only")).toBe("Plain text only");
    expect(taskSummary("## Context\nWhy this matters", "Other")).toBe("Context Why this matters");
  });
});
