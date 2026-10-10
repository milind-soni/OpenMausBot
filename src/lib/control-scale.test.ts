// The control scale in styles.css: one 32/28/24px button ladder, one 28px
// transcript pill, one 22px chip, one inline-code chip and one menu row.
// Each step keeps a medium weight and a line box that centers its label.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { DigestChip } from "@/components/DigestChip";
import type { Message } from "@/state/store";

const src = join(dirname(fileURLToPath(import.meta.url)), "..");
// windows checkouts can carry crlf line endings
const css = readFileSync(join(src, "styles.css"), "utf8").replace(/\r\n/g, "\n");

function rule(selector: string): Record<string, string> {
  const start = css.indexOf(`  ${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start)).replace(/\/\*[\s\S]*?\*\//g, "");
  return Object.fromEntries(body.split(";").map((line) => line.trim()).filter(Boolean)
    .map((line) => [line.slice(0, line.indexOf(":")).trim(), line.slice(line.indexOf(":") + 1).trim()]));
}

describe("control scale", () => {
  it("steps buttons 32, 28 and 24px with a centered medium label", () => {
    const base = rule(".ui-button,\n  .ui-icon-button");
    expect(base).toMatchObject({ "min-height": "2rem", "font-size": "13px", "font-weight": "500", "line-height": "1.25rem", "align-items": "center" });
    // padding plus line plus border stays under min-height, so 32px is real
    expect(rule(".ui-button")).toMatchObject({ padding: "0.25rem 0.75rem" });
    expect(rule(".ui-button-md")).toMatchObject({ "min-height": "1.75rem", "font-size": "13px", "line-height": "1.25rem" });
    expect(rule(".ui-button-sm")).toMatchObject({ "min-height": "1.5rem", "font-size": "12px", "line-height": "1rem" });
    expect(rule(".ui-button-primary")).toMatchObject({ background: "var(--color-accent)", color: "var(--color-accent-ink)" });
  });

  it("gives pills, chips, code and menu rows one size each", () => {
    expect(rule(".ui-pill")).toMatchObject({ "min-height": "1.75rem", "border-radius": "9999px", "font-size": "13px", "font-weight": "500", "line-height": "1.25rem", "align-items": "center" });
    expect(rule(".ui-chip")).toMatchObject({ "min-height": "1.375rem", "border-radius": "9999px", "font-size": "12px", "font-weight": "500", "line-height": "1rem" });
    expect(rule(".ui-code-chip")).toMatchObject({ "box-decoration-break": "clone", "font-family": "var(--font-mono)", "font-size": "0.92em", "line-height": "1" });
    expect(rule(".ui-menu-row")).toMatchObject({ "min-height": "2.25rem", "font-size": "14px", "line-height": "1.25rem", gap: "0.75rem" });
  });

  it("keeps every step on skin tokens", () => {
    for (const selector of [".ui-button-md", ".ui-button-sm", ".ui-button-primary", ".ui-pill", ".ui-chip", ".ui-code-chip", ".ui-menu-row"]) {
      expect(Object.values(rule(selector)).join(" "), selector).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    }
  });

  it("is what the digest chip and inline code render with", () => {
    const message: Message = {
      id: "digest", role: "bot", kind: "digest", at: 1,
      digest: { turnId: "t", botId: "b", threadId: "th", at: 1, durationMs: 1, tools: [{ name: "Read", count: 2, failed: 0 }],
        files: { changed: [], added: [], deleted: [] }, memory: [], reply: "", hookCoverage: "preview" },
    };
    expect(renderToStaticMarkup(createElement(DigestChip, { message }))).toMatch(/class="ui-chip /);
    const html = renderToStaticMarkup(createElement(ChatMarkdown, { text: "run `pnpm test` now" }));
    expect(html).toContain('class="ui-code-chip break-words [unicode-bidi:isolate]"');
    expect(html).not.toContain("text-[13px]");
  });
});
