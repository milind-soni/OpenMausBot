// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { describe, expect, it, vi } from "vitest";
import { RichTable } from "./RichTable";
import { ChatMarkdown } from "./ChatMarkdown";
import { CHAR_PX, COLUMN_MAX_CHARS, COLUMN_MIN_CHARS, columnMinimums, fitsColumns } from "@/lib/table-fit";
import { formattedReplyWidth } from "@/lib/formatted-reply";

// Simple mode draws its own plain table; this pins the Advanced table's fitting.
vi.mock("@/lib/interface-mode", async (original) => ({ ...(await original<typeof import("@/lib/interface-mode")>()), useAdvancedMode: () => true, readAdvancedMode: () => true }));

const header = ["App", "Stars", "License", "Target user", "Strength", "Weakness", "Verdict"];
const row = ["OpenHands (ex-OpenDevin)", "~85k", "MIT", "Developers who want an autonomous coder",
  "Runs real software tasks end to end", "Needs a strong model and a sandbox", "Best open coding agent today"];
const markdown = [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, ...Array.from({ length: 10 }, () => `| ${row.join(" | ")} |`)].join("\n");

function parse(html: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, "text/html");
}

describe("a table in a reply", () => {
  it("fits every column to the message: auto layout, wrapped cells, no fixed widths and no inner scroll box", () => {
    const doc = parse(renderToStaticMarkup(createElement(ChatMarkdown, { text: markdown })));
    const table = doc.querySelector("table")!;
    expect(table.className).toContain("table-auto");
    expect(table.className).toContain("w-full");
    expect(table.getAttribute("style")).toBeNull();
    expect(doc.querySelector("colgroup")).toBeNull();
    const viewport = doc.querySelector<HTMLElement>("[role=region]")!;
    expect(viewport.dataset.fit).toBe("true");
    expect(viewport.getAttribute("style") ?? "").not.toContain("max-height");
    expect(doc.querySelectorAll("th")).toHaveLength(7);
    const floors = [...doc.querySelectorAll<HTMLElement>("th > div")].map((cell) => Number.parseFloat(cell.style.minWidth));
    expect(floors).toEqual(columnMinimums(header, [row]));
    expect(floors.reduce((sum, width) => sum + width, 0) + 7 * 24).toBeLessThan(704);
    for (const cell of doc.querySelectorAll("td > div")) expect(cell.className).toContain("[overflow-wrap:anywhere]");
    const surface = doc.querySelector(".rich-table")!;
    expect(surface.className).toContain("w-fit");
    expect(surface.className).toContain("min-w-[min(100%,var(--chat-prose-max))]");
    expect(surface.parentElement!.className).toBe("chat-table");
  });

  it("keeps fixed columns and a scroll box for a very long table, whose rows are drawn as they scroll", () => {
    const doc = parse(renderToStaticMarkup(createElement(RichTable, {
      columns: header.map((text) => ({ text })), rows: Array.from({ length: 500 }, () => row.map((text) => ({ text }))),
    })));
    expect(doc.querySelector("table")!.className).toContain("table-fixed");
    expect(doc.querySelectorAll("col")).toHaveLength(7);
    expect(doc.querySelector<HTMLElement>("[role=region]")!.style.maxHeight).toBe("400px");
    expect(fitsColumns({ wrap: true, virtual: false })).toBe(true);
    expect(fitsColumns({ wrap: false, virtual: false })).toBe(false);
    expect(fitsColumns({ wrap: true, virtual: true })).toBe(false);
  });

  it("keeps roomy columns and scrolls sideways, with no inner scroll box, when even the narrowest columns cannot fit", () => {
    const minimums = columnMinimums(header, [row]);
    const needed = minimums.reduce((sum, width) => sum + width + 24, 0);
    expect(fitsColumns({ wrap: true, virtual: false, minimums, available: needed })).toBe(true);
    expect(fitsColumns({ wrap: true, virtual: false, minimums, available: needed - 1 })).toBe(false);
    let report: () => void = () => undefined;
    vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { report = callback; } observe() {} disconnect() {} });
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "region" ? 300 : 0;
    });
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      flushSync(() => root.render(createElement(RichTable, { columns: header.map((text) => ({ text })), rows: Array.from({ length: 10 }, () => row.map((text) => ({ text }))) })));
      expect(host.querySelector("table")!.className).toContain("table-auto");
      flushSync(() => report());
      const viewport = host.querySelector<HTMLElement>("[role=region]")!;
      expect(host.querySelector("table")!.className).toContain("table-fixed");
      expect(host.querySelectorAll("col")).toHaveLength(7);
      expect(viewport.dataset.fit).toBeUndefined();
      expect(viewport.style.maxHeight).toBe("");
    } finally {
      root.unmount();
      width.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("floors a column at its longest word, within bounds", () => {
    expect(columnMinimums(["ID", "Notes"], [["7", "a"], ["12", "Extraordinarily-long-identifier here"]])).toEqual([
      COLUMN_MIN_CHARS * CHAR_PX, COLUMN_MAX_CHARS * CHAR_PX,
    ]);
    expect(columnMinimums(["Verdict"], [["Best open coding agent"]])).toEqual([Math.round(7 * CHAR_PX)]);
  });

  it("gives a reply with a table the message's full width and keeps its prose at reading width", () => {
    expect(formattedReplyWidth(markdown)).toContain("max-w-[var(--chat-card-pct)]");
    expect(formattedReplyWidth(markdown)).toContain("chat-wide");
    expect(formattedReplyWidth("- one\n- two")).toBe("w-full max-w-[min(var(--chat-prose-max),var(--chat-card-pct))]");
    const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
    expect(css).toMatch(/\.chat-wide \.chat-md > :not\(\.chat-table\) \{\s*max-width: var\(--chat-prose-max\);/);
  });
});
