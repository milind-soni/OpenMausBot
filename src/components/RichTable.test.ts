import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Advanced mode's table chrome; Simple mode's table card has its own tests below.
const mode = vi.hoisted(() => ({ advanced: true }));
vi.mock("@/lib/interface-mode", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/interface-mode")>(),
  useAdvancedMode: () => mode.advanced,
  readAdvancedMode: () => mode.advanced,
}));
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
    expect(html).toContain('scope="col"');
  });
  it("gives a short table its actions without the search box and row count a long one needs", () => {
    const table = (length: number) => renderToStaticMarkup(createElement(RichTable, { columns: [{ text: "ID" }], rows: Array.from({ length }, (_, i) => [{ text: String(i) }]) }));
    const short = table(8);
    expect(short).not.toContain('aria-label="Search all rows…"');
    expect(short).not.toContain("8 of 8 rows");
    expect(short).toContain('aria-label="Copy results as CSV"');
    const long = table(9);
    expect(long).toContain('aria-label="Search all rows…"');
    expect(long).toContain("9 of 9 rows");
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

describe("Simple mode's table card", () => {
  const card = (rows: number) => {
    mode.advanced = false;
    try {
      return renderToStaticMarkup(createElement(RichTable, {
        columns: [{ text: "Sender" }, { text: "Emails" }],
        rows: Array.from({ length: rows }, (_, index) => [{ text: `Sender ${index}` }, { text: String(index) }]),
      }));
    } finally {
      mode.advanced = true;
    }
  };

  it("draws a short table as a card with a hover plate, header names that sort, and no footer", () => {
    const html = card(3);
    const surface = html.match(/<div data-table-card="[^"]*" class="([^"]*)"/)?.[1] ?? "";
    expect(surface.split(" ")).toEqual(expect.arrayContaining(["rounded-[20px]", "bg-composer", "touch:pt-11"]));
    // The header row starts at the card's top: the plate floats over it instead of keeping a band at rest.
    expect(surface.split(" ").some((name) => /^(pt|py|p)-/.test(name))).toBe(false);
    const plate = html.match(/<div class="(table-plate [^"]*)"/)?.[1] ?? "";
    expect(plate.split(" ")).toEqual(expect.arrayContaining(["absolute", "top-1.5", "end-1.5", "bg-composer", "opacity-0", "group-hover/table:opacity-100", "focus-within:opacity-100", "touch:opacity-100"]));
    expect(html).toContain('aria-label="Copy table"');
    expect(html).toContain('aria-label="Download results as CSV"');
    expect(html).toContain('aria-label="Expand table"');
    expect(html).toMatch(/<button type="button" class="group\/th [^"]*" aria-label="Sort by Sender"[^>]*><span dir="auto">Sender<\/span>/);
    expect(html).toContain("border-t-[0.5px] border-ink/[0.07]");
    expect(html).not.toContain("<footer");
    expect(html).not.toContain(`aria-label="${"Search all rows…"}"`);
    expect(html).toContain('data-fit="true"');
  });

  it("puts search and the row count inside the card once a table runs past eight rows", () => {
    const html = card(12);
    expect(html).toContain('aria-label="Search all rows…"');
    expect(html).toContain("12 of 12 rows · 2 columns");
    expect(html).not.toContain("<footer");
  });
});
