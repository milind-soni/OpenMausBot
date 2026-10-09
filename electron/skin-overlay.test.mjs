import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { SKIN_CHROME, DEFAULT_SKIN, skinChrome, isKnownSkin } = require("./skin-overlay.cjs");

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "../src/styles.css"), "utf8");
const skinIds = readFileSync(join(here, "../src/lib/skins.ts"), "utf8");

// The value CSS defines for one custom property inside one skin's block.
function cssToken(skin, name) {
  const block = css.match(new RegExp(`\\[data-skin="${skin}"\\]\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  return block.match(new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]+)`))?.[1]?.toLowerCase() ?? null;
}

describe("skin overlay chrome", () => {
  it("covers exactly the skins the renderer ships", () => {
    // SKIN_IDS is the source of truth (src/lib/skins.ts); a skin added there
    // without a chrome entry here would leave that skin's caption buttons on
    // the previous colour — the issue #454 failure, but for a new skin.
    const registered = [...skinIds.matchAll(/"([a-z-]+)"/g)]
      .map(([, id]) => id)
      .filter((id) => css.includes(`[data-skin="${id}"]`));
    expect(new Set(registered)).toEqual(new Set(Object.keys(SKIN_CHROME)));
  });

  it("matches each skin's --color-app (the header strip is bg-app)", () => {
    for (const [skin, chrome] of Object.entries(SKIN_CHROME)) {
      expect(chrome.color.toLowerCase()).toBe(cssToken(skin, "--color-app"));
    }
  });

  it("uses opaque symbol colours the overlay can accept", () => {
    // The Windows overlay rejects alpha, so every symbolColor must be a plain
    // 6-digit hex even though the CSS ink tokens may carry an alpha byte.
    for (const chrome of Object.values(SKIN_CHROME)) {
      expect(chrome.symbolColor).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it("falls back to the default skin for anything unknown, never throwing", () => {
    expect(isKnownSkin("midnight")).toBe(true);
    expect(isKnownSkin("does-not-exist")).toBe(false);
    expect(isKnownSkin(undefined)).toBe(false);
    expect(isKnownSkin(42)).toBe(false);
    expect(skinChrome("does-not-exist")).toEqual(SKIN_CHROME[DEFAULT_SKIN]);
    expect(skinChrome(null)).toEqual(SKIN_CHROME[DEFAULT_SKIN]);
  });

  it("paints Meadow's white page behind the caption buttons", () => {
    expect(skinChrome("meadow")).toEqual({ color: "#ffffff", symbolColor: "#4d5a52" });
    expect(isKnownSkin("meadow")).toBe(true);
  });
});
