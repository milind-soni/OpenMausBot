import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolActivity } from "./ToolActivity";

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
  it("shows a non-zero exit with real output as an amber warning, not a failure", () => {
    const output = "Exit code 1\nNew Photos\n/usr/local/bin/ffprobe\n/usr/bin/mdls";
    const html = renderToStaticMarkup(createElement(ToolActivity, { tool: { name: "Bash", ok: false, summary: "ls -la | grep -i photos; which exiftool", output } }));
    expect(html).toContain("Bash · exit 1 · Tool details");
    expect(html).toContain('data-testid="tool-exit"');
    expect(html).toContain("text-warning");
    expect(html).not.toContain("text-danger");
    expect(html).not.toContain(">Failed<");
  });
  it("keeps timeouts and empty non-zero exits red", () => {
    const render = (output: string) => renderToStaticMarkup(createElement(ToolActivity, { tool: { name: "Bash", ok: false, output } }));
    for (const output of ["Exit code 143\nline one\nline two\nCommand timed out after 2m 0s", "Exit code 1"]) {
      const html = render(output);
      expect(html).toContain("Bash · Failed · Tool details");
      expect(html).toContain("text-danger");
      expect(html).not.toContain('data-testid="tool-exit"');
    }
  });
});
