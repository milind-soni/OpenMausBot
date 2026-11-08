import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AttachedFileChip } from "./AttachmentPreview";
import { isMarkdownFile } from "./HtmlFilePreview";
import { MARKDOWN_PREVIEW_MAX_BYTES, MarkdownFileView } from "./MarkdownFilePreview";
import { readTableResponse } from "./TableFilePreview";

const message = { threadId: "t", messageId: "m" };
const chip = (name: string, withMessage = true) =>
  renderToStaticMarkup(createElement(AttachedFileChip, { file: { name, path: `/workspace/${name}`, private: true }, ...(withMessage ? { message } : {}) }));
const view = (source: string, showSource: boolean) => renderToStaticMarkup(createElement(MarkdownFileView, { source, showSource }));

describe("isMarkdownFile (#4765)", () => {
  it.each(["notes.md", "README.MD", "guide.markdown"])("accepts %s", (name) => expect(isMarkdownFile(name)).toBe(true));
  it.each(["notes.txt", "page.html", "md", "notes.md.zip", "data.mdx"])("rejects %s", (name) => expect(isMarkdownFile(name)).toBe(false));
});

describe("Markdown file chip (#4765)", () => {
  it("opens a preview from the file name and keeps saving on its own button", () => {
    const html = chip("report.md");
    expect(html).toMatch(/aria-label="Preview: report.md"[^>]*>[^]*report\.md/);
    expect(html).toMatch(/class="table-action" aria-label="Save a copy of report.md"/);
    expect(html).not.toContain("Preview page:");
  });

  it("stays a plain download outside a message, and other files are unchanged", () => {
    expect(chip("report.md", false)).not.toContain("Preview: report.md");
    expect(chip("notes.txt")).not.toContain("Preview:");
    expect(chip("report.html")).toContain("Preview page: report.html");
  });
});

describe("MarkdownFileView (#4765)", () => {
  const source = "# Weekly report\n\n| Team | Done |\n| --- | --- |\n| Ops | 4 |\n\n- **one**\n- two\n\nSee /workspace/secret.txt";

  it("draws headings, tables and lists", () => {
    const html = view(source, false);
    expect(html).toMatch(/class="md-heading[^"]*">Weekly report</);
    expect(html).toContain("<table");
    expect(html).toContain("<strong>one</strong>");
  });

  it("keeps paths in the file as text, never links to other files", () => {
    const html = view(source, false);
    expect(html).toContain("/workspace/secret.txt");
    expect(html).not.toMatch(/<(a|button)[^>]*>[^<]*\/workspace\/secret\.txt/);
  });

  it("shows the raw text when asked", () => {
    const html = view(source, true);
    expect(html).toContain("<pre");
    expect(html).toContain("# Weekly report");
    expect(html).not.toContain("<table");
  });

  it("stops a file at its cap", async () => {
    const signal = new AbortController().signal;
    await expect(readTableResponse(new Response(new Uint8Array(MARKDOWN_PREVIEW_MAX_BYTES + 1)), signal, MARKDOWN_PREVIEW_MAX_BYTES)).rejects.toThrow("size");
  });
});
