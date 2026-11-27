import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GROK_BOT_MARK_PATH, GrokBotMark } from "./GrokBotMark";
import { GrokBotMark as FromProviderIcons } from "./ProviderIcons";

describe("the Grok Bot mark", () => {
  it("is plain path data: commands and numbers, nothing else", () => {
    expect(GROK_BOT_MARK_PATH).toMatch(/^M[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/);
    expect(GROK_BOT_MARK_PATH.length).toBeGreaterThan(500);
  });

  it("renders a static svg with one path: no script, handlers, links, styles or foreign content", () => {
    const markup = renderToStaticMarkup(createElement(GrokBotMark, { size: 20 }));
    expect([...markup.matchAll(/<([a-zA-Z][\w:-]*)/g)].map((match) => match[1])).toEqual(["svg", "path"]);
    expect(markup).not.toMatch(/<script|foreignObject|<style|<image|<use\b/i);
    expect(markup).not.toMatch(/\son\w+=/i);
    expect(markup).not.toMatch(/href|xlink|url\(|javascript:|data:/i);
    // Themes with the ink colour, like the other provider marks.
    expect(markup).toContain("fill-[var(--color-ink)]");
    expect(markup).toContain('viewBox="0 0 70 70"');
    expect(markup).toContain('aria-hidden="true"');
    expect(FromProviderIcons).toBe(GrokBotMark);
  });
});
