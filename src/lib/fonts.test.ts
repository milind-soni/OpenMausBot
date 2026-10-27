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
    for (const id of blocks) expect(FONT_IDS).toContain(id as (typeof FONT_IDS)[number]);
  });

  it("leads every skin with the bundled Geist face, except the paper skins and Pop", () => {
    const skins = [...css.matchAll(/\[data-skin="([a-z-]+)"\]\s*\{[^}]*?--font-sans:\s*([^;]+);/g)];
    expect(skins.length).toBeGreaterThan(8);
    for (const [, skin, stack] of skins) {
      const first = stack.split(",")[0].trim();
      if (["atelier", "lagoon", "linen"].includes(skin)) expect(first, skin).toBe("system-ui");
      else if (skin === "pop") expect(first, skin).toBe('"Plus Jakarta Sans"');
      else expect(first, skin).toBe('"Geist Variable"');
    }
    expect(css).toMatch(/@import "@fontsource-variable\/geist";/);
    expect(css).toMatch(/--font-mono:\s*"Geist Mono Variable"/);
  });

  it("spells BlinkMacSystemFont exactly, since Chromium skips any other casing", () => {
    for (const [match] of css.matchAll(/blinkmacsystemfont/gi)) expect(match).toBe("BlinkMacSystemFont");
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
