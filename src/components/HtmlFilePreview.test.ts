import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AttachedFileChip } from "./AttachmentPreview";
import { HTML_PREVIEW_MAX_BYTES, HtmlPreviewFrame, htmlPreviewDocument, isHtmlFile } from "./HtmlFilePreview";
import { readTableResponse } from "./TableFilePreview";

const message = { threadId: "t", messageId: "m" };
const chip = (name: string, extra: { private?: boolean } = {}, withMessage = true) =>
  renderToStaticMarkup(createElement(AttachedFileChip, { file: { name, path: `/workspace/${name}`, private: true, ...extra }, ...(withMessage ? { message } : {}) }));

describe("isHtmlFile", () => {
  it.each(["report.html", "index.htm", "REPORT.HTML"])("accepts %s", (name) => expect(isHtmlFile(name)).toBe(true));
  it.each(["data.csv", "notes.md", "html.txt", "page.html.zip", "html"])("rejects %s", (name) => expect(isHtmlFile(name)).toBe(false));
});

describe("htmlPreviewDocument", () => {
  const doc = htmlPreviewDocument("<h1>Report</h1><script>alert(1)</script>");

  it("opens with a policy that fetches nothing and allows no script", () => {
    const policy = doc.match(/^<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)?.[1];
    expect(policy).toContain("default-src 'none'");
    expect(policy).not.toMatch(/script-src|connect-src|frame-src|https?:/);
  });

  it("points links at a blocked popup and keeps the page after the guards", () => {
    expect(doc).toContain('<base target="_blank">');
    expect(doc.endsWith("<h1>Report</h1><script>alert(1)</script>")).toBe(true);
  });
});

describe("HtmlPreviewFrame", () => {
  const markup = renderToStaticMarkup(createElement(HtmlPreviewFrame, { source: "<p>hi</p>", name: "report.html" }));

  it("renders in an empty sandbox: no scripts, no same-origin, no popups, no navigation", () => {
    expect(markup).toContain('sandbox=""');
    expect(markup).not.toMatch(/allow-/);
  });

  it("loads the page inline, never from a URL, and names the frame", () => {
    expect(markup).toContain("srcDoc=");
    expect(markup).not.toMatch(/\ssrc="/);
    expect(markup).toContain('referrerPolicy="no-referrer"');
    expect(markup).toContain('title="Preview of report.html"');
  });
});

describe("file chip preview button", () => {
  it("offers a page preview for HTML and keeps the table preview for CSV", () => {
    expect(chip("report.html")).toContain("Preview page: report.html");
    expect(chip("report.html")).not.toContain("Preview table:");
    expect(chip("data.csv")).toContain("Preview table: data.csv");
    expect(chip("notes.txt")).not.toMatch(/Preview (page|table):/);
  });

  it("offers no preview for files outside a message or not shared privately", () => {
    expect(chip("report.html", {}, false)).not.toContain("Preview page:");
    expect(chip("report.html", { private: false })).not.toContain("Preview page:");
  });
});

describe("bounded read", () => {
  it("stops an HTML page at its own cap", async () => {
    const signal = new AbortController().signal;
    expect(await readTableResponse(new Response("<p>ok</p>"), signal, HTML_PREVIEW_MAX_BYTES)).toBe("<p>ok</p>");
    await expect(readTableResponse(new Response(new Uint8Array(HTML_PREVIEW_MAX_BYTES + 1)), signal, HTML_PREVIEW_MAX_BYTES)).rejects.toThrow("size");
  });
});
