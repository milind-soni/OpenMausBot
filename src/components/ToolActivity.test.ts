import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The tool's own name on the row is Advanced mode's; Simple mode's plain
// words are covered in ToolActivity.simple.test.ts.
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => true }));
const { ToolActivity } = await import("./ToolActivity");

describe("ToolActivity", () => {
  it("starts collapsed with an accessible status and escaped input/output", () => {
    const html = renderToStaticMarkup(createElement(ToolActivity, { tool: { name: "Bash", ok: true, input: "echo hi", output: "<script>unsafe()</script>" } }));
    expect(html).toContain("<details");
    expect(html).not.toContain(" open=");
    expect(html).toContain("Bash · Completed · Tool details");
    expect(html).toContain('role="button"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("echo hi");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
  it("distinguishes pending, failed and unrecorded output", () => {
    const render = (ok?: boolean) => renderToStaticMarkup(createElement(ToolActivity, { tool: { name: "Read", ok } }));
    expect(render()).toContain("Waiting for the tool to finish");
    expect(render(false)).toContain("Failed");
    expect(render(false)).toContain("No output was recorded");
    expect(render(true)).toContain("No output was recorded");
  });
});
