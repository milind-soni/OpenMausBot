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
  it("always offers honest recovery for browser sites, including silent embedding refusals", () => {
    const html = renderToStaticMarkup(createElement(PreviewFrame, {
      source: { kind: "url", url: "https://example.com/denied", raw: "example.com/denied", isLocalOrPrivate: false },
      width: 800, height: 600,
    }));
    expect(html).toContain("Preview blank?");
    expect(html).toContain("Open in new tab");
    expect(html).toContain("Retry");
    expect(html).toContain('href="https://example.com/denied"');
    expect(html).not.toContain("This site doesn");
  });
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
