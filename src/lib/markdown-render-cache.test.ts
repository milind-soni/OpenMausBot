import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { createMarkdownRenderCache, MARKDOWN_BYTES_PER_CHAR } from "./markdown-render-cache";

const element = (text: string) => createElement("p", null, text);

describe("markdown render cache", () => {
  it("keeps a rendering per text and variant", () => {
    const cache = createMarkdownRenderCache();
    const render = vi.fn(() => element("a"));
    const first = cache.render("a", "v1", render);
    expect(cache.render("a", "v1", render)).toBe(first);
    expect(render).toHaveBeenCalledTimes(1);
    const other = cache.render("a", "v2", render);
    expect(other).not.toBe(first);
    expect(render).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(1);
    expect(cache.bytes).toBe(MARKDOWN_BYTES_PER_CHAR);
  });

  it("lets the least recently drawn text go first when the budget is spent", () => {
    const cache = createMarkdownRenderCache(30 * MARKDOWN_BYTES_PER_CHAR);
    const text = (name: string) => name.repeat(10);
    for (const name of ["a", "b", "c"]) cache.render(text(name), "", () => element(name));
    cache.render(text("a"), "", () => element("again"));
    cache.render(text("d"), "", () => element("d"));
    expect(cache.size).toBe(3);
    expect(cache.bytes).toBe(30 * MARKDOWN_BYTES_PER_CHAR);
    const render = vi.fn(() => element("fresh"));
    cache.render(text("a"), "", render);
    expect(render).not.toHaveBeenCalled();
    cache.render(text("b"), "", render);
    expect(render).toHaveBeenCalledOnce();
  });

  it("does not hold a text over the size limit", () => {
    const cache = createMarkdownRenderCache(1_000_000, 100);
    const render = vi.fn(() => element("big"));
    cache.render("x".repeat(101), "", render);
    cache.render("x".repeat(101), "", render);
    expect(render).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });
});
