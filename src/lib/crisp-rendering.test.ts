import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "../styles.css"), "utf8");
const body = css.match(/body\s*\{([^}]*)\}/)?.[1] ?? "";

describe("crisp rendering", () => {
  it("uses greyscale font smoothing", () => {
    // Chromium on macOS thickens every stem under `auto`, so regular text reads close to semibold.
    expect(body).toMatch(/-webkit-font-smoothing:\s*antialiased/);
    expect(body).toMatch(/-moz-osx-font-smoothing:\s*grayscale/);
  });

  it("does not pin Chromium to an sRGB color profile", () => {
    const main = readFileSync(join(here, "../../electron/main.mjs"), "utf8");
    expect(main).not.toMatch(/force-color-profile/);
    expect(main).not.toMatch(/disable-color-correct-rendering/);
  });
});
