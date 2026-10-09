import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RichTable } from "./RichTable";
import { ChatMarkdown } from "./ChatMarkdown";
import { AttachedFileChip } from "./AttachmentPreview";
import { readTableResponse } from "./TableFilePreview";
import { TABLE_FILE_MAX_BYTES } from "@/lib/table-data";

describe("rich table rendering", () => {
  it("keeps Markdown links, emphasis, code, alignment and escaped HTML inside cells", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, { text: '| Name | Amount |\n| :--- | ---: |\n| **Alpha** [docs](https://example.com) `code` | 12 |\n| <script>alert(1)</script> | 2 |' }));
    expect(html).toContain("<strong>Alpha</strong>");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain("code");
    expect(html).toContain("text-align:right");
    expect(html).not.toContain("<script>");
    expect(html).toContain("2 of 2 rows");
    expect(html).toContain('scope="col"');
  });
  it("bounds the DOM for a large table", () => {
    const html = renderToStaticMarkup(createElement(RichTable, { columns: [{ text: "ID" }], rows: Array.from({ length: 5000 }, (_, i) => [{ text: String(i) }]) }));
    expect(html).toContain('aria-rowcount="5001"');
    expect((html.match(/aria-rowindex=/g) ?? []).length).toBeLessThan(50);
  });
  it("offers file previews only for message-scoped attachments or authored links", () => {
    const file = { name: "report.csv", path: "/workspace/report.csv", private: true };
    const message = { threadId: "t", messageId: "m" };
    expect(renderToStaticMarkup(createElement(AttachedFileChip, { file, message }))).toContain("Preview table: report.csv");
    expect(renderToStaticMarkup(createElement(AttachedFileChip, { file }))).not.toContain("Preview table:");
    expect(renderToStaticMarkup(createElement(AttachedFileChip, { file: { ...file, private: false }, message }))).not.toContain("Preview table:");
  });
  it("reads chunked UTF-8 data and rejects too-large responses", async () => {
    const signal = new AbortController().signal;
    expect(await readTableResponse(new Response("A,B\n中文,2"), signal)).toBe("A,B\n中文,2");
    await expect(readTableResponse(new Response("", { headers: { "content-length": String(TABLE_FILE_MAX_BYTES + 1) } }), signal)).rejects.toThrow("size");
    await expect(readTableResponse(new Response(new Uint8Array(TABLE_FILE_MAX_BYTES + 1)), signal)).rejects.toThrow("size");
    await expect(readTableResponse(new Response("A,B"), AbortSignal.abort())).rejects.toThrow();
    await expect(readTableResponse(new Response(new Uint8Array([0xff])), signal)).rejects.toThrow();
  });
});
