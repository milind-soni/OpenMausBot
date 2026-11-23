import { describe, expect, it } from "vitest";
import { applyThemeColor, type ThemeColorDocument } from "./browser-chrome";

function meta() {
  const attrs = new Map<string, string>();
  return {
    attrs,
    getAttribute: (name: string) => attrs.get(name) ?? null,
    setAttribute: (name: string, value: string) => { attrs.set(name, value); },
  };
}

function doc(existing?: ReturnType<typeof meta>): ThemeColorDocument & { created: ReturnType<typeof meta>[] } {
  const created: ReturnType<typeof meta>[] = [];
  return {
    created,
    head: {
      querySelector: () => existing ?? null,
      appendChild: (node) => { created.push(node as ReturnType<typeof meta>); },
    },
    createElement: () => meta(),
  };
}

describe("theme-color follows the skin ground", () => {
  it("creates the meta with a dark app ground", () => {
    const page = doc();
    expect(applyThemeColor("#121212", page)).toBe(true);
    expect(page.created).toHaveLength(1);
    expect(page.created[0].getAttribute("name")).toBe("theme-color");
    expect(page.created[0].getAttribute("content")).toBe("#121212");
  });

  it("replaces an existing light bar color when the skin is dark", () => {
    const bar = meta();
    bar.setAttribute("name", "theme-color");
    bar.setAttribute("content", "#fcfcfc");
    const page = doc(bar);
    expect(applyThemeColor("  #0b0c0b  ", page)).toBe(true);
    expect(page.created).toHaveLength(0);
    expect(bar.getAttribute("content")).toBe("#0b0c0b");
  });

  it("leaves the bar alone when the surface is not a hex color", () => {
    const page = doc();
    expect(applyThemeColor("var(--color-app)", page)).toBe(false);
    expect(applyThemeColor("", page)).toBe(false);
    expect(page.created).toHaveLength(0);
  });
});
