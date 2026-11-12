import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PreviewFrame } from "../components/PreviewFrame";

function renderFile(fileType: "html" | "pdf" | "image", filePath: string) {
  return renderToStaticMarkup(createElement(PreviewFrame, {
    source: { kind: "file", projectId: "test", fileType, filePath },
    width: 800, height: 600,
  }));
}

describe("project preview frame isolation", () => {
  it("allows the native PDF viewer without loosening HTML or SVG frames", () => {
    const pdf = renderFile("pdf", "report.pdf");
    expect(pdf).toContain("<iframe");
    expect(pdf).not.toContain("sandbox=");
    const html = renderFile("html", "index.html");
    expect(html).toContain('sandbox="allow-scripts allow-forms"');
    expect(html).not.toContain("allow-same-origin");
    const svg = renderFile("image", "image.svg");
    expect(svg).toContain("<img");
    expect(svg).not.toContain("<iframe");
  });
});
