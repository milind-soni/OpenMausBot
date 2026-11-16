import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkObsidian, splitFrontmatter, toggleTaskLine } from "./obsidianMarkdown";

const html = (md: string) => renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm, remarkObsidian] }, md));

describe("Obsidian Markdown", () => {
  it("renders callouts with a title and body", () => {
    const out = html("> [!warning] Careful now\n> Body text");
    expect(out).toContain('class="callout" data-callout="warning"');
    expect(out).toContain('<div class="callout-title">Careful now</div>');
    expect(out).toContain("Body text");
    expect(html("> [!tip]\n> Hi")).toContain('<div class="callout-title">Tip</div>');
  });
  it("renders highlights, wikilinks and tags but not inside code", () => {
    const out = html("A ==big== [[Note|alias]] and [[Other]] #project/x, `==no==`");
    expect(out).toContain('<mark class="md-highlight">big</mark>');
    expect(out).toContain('<span class="internal-link" title="Note">alias</span>');
    expect(out).toContain('<span class="internal-link" title="Other">Other</span>');
    expect(out).toContain('<span class="tag">#project/x</span>');
    expect(out).toContain("<code>==no==</code>");
    expect(html("issue#12 and a.b#c")).not.toContain("tag");
  });
  it("parses frontmatter into properties", () => {
    const fm = splitFrontmatter("---\ntitle: \"Plan\"\ntags:\n  - a\n  - b\n---\n# Body\n");
    expect(fm.properties).toEqual([["title", "Plan"], ["tags", "a, b"]]);
    expect(fm.body).toBe("# Body\n");
    expect(fm.lineOffset).toBe(6);
    expect(splitFrontmatter("# none").properties).toEqual([]);
  });
  it("toggles task checkboxes on a source line", () => {
    const src = "- [ ] one\n  - [x] two\nplain";
    expect(toggleTaskLine(src, 1)).toBe("- [x] one\n  - [x] two\nplain");
    expect(toggleTaskLine(src, 2)).toBe("- [ ] one\n  - [ ] two\nplain");
    expect(toggleTaskLine(src, 3)).toBe(src);
  });
});
