// Registry and stylesheet are two halves of one contract: a font listed here
// without a CSS block silently renders as the skin's font, so it gets a test.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FONT, FONT_IDS, applyFont, readFont } from "./fonts";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../styles.css"),
  "utf8",
);

const blocks = new Set(
  [...css.matchAll(/:root\[data-font="([a-z-]+)"\]/g)].map(([, id]) => id),
);

describe("fonts", () => {
  // Vitest runs in node here: stand in the two globals the module touches.
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    vi.stubGlobal("document", { documentElement: { dataset: {} as DOMStringMap } });
  });

  it("gives every non-default font a stylesheet block that sets --font-sans", () => {
    for (const id of FONT_IDS.filter((f) => f !== DEFAULT_FONT)) {
      expect(blocks).toContain(id);
      const body = css.match(new RegExp(`:root\\[data-font="${id}"\\]\\s*\\{([^}]*)\\}`))?.[1] ?? "";
      expect(body).toMatch(/--font-sans\s*:/);
    }
  });

  it("registers every stylesheet block", () => {
    // SAFETY: the assertion only fits toContain()'s parameter type.
    for (const id of blocks) expect(FONT_IDS).toContain(id as (typeof FONT_IDS)[number]);
  });

  it("stamps a chosen font and remembers it", () => {
    applyFont("poppins");
    expect(document.documentElement.dataset.font).toBe("poppins");
    expect(readFont()).toBe("poppins");
  });

  it("clears the attribute for the skin default", () => {
    applyFont("poppins");
    applyFont(DEFAULT_FONT);
    expect(document.documentElement.dataset.font).toBeUndefined();
    expect(readFont()).toBe(DEFAULT_FONT);
  });

  it("falls back to the default for an unknown stored value", () => {
    localStorage.setItem("omb-font", "comic-sans");
    expect(readFont()).toBe(DEFAULT_FONT);
  });
});
