import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { codeToHtml } from "shiki";

import { CODE_HIGHLIGHT_OPTIONS } from "./code-highlight";

describe("chat code highlighting", () => {
  it("emits both light and dark token colors instead of hardcoding a dark-theme foreground", async () => {
    const html = await codeToHtml("const result = true", {
      lang: "ts",
      ...CODE_HIGHLIGHT_OPTIONS,
    });

    expect(html).toContain("--shiki-light:");
    expect(html).toContain("--shiki-dark:");
    expect(html).toContain("--shiki-light-bg:");
    expect(html).toContain("--shiki-dark-bg:");
  });

  it("maps both theme variables to the app's light and dark skins", () => {
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

    expect(css).toContain("--shiki-light");
    expect(css).toContain("--shiki-dark");
    expect(css).toMatch(/data-skin="centipede"[^}]+--shiki-light/s);
    expect(css).toMatch(/data-skin="midnight"[^}]+--shiki-dark/s);
  });
});
