// Tailwind generates a colour utility only for `--color-*` tokens in `@theme`; any other name compiles to nothing, silently.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const src = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(src, "styles.css"), "utf8");

const theme = css.match(/@theme\s*\{([^}]*)\}/)?.[1] ?? "";
const defined = new Set([...theme.matchAll(/--color-([\w-]+)\s*:/g)].map(([, name]) => name));

// Only names that read like the app's own tokens, so Tailwind's built-in palette never trips it.
const families = new Set([...[...defined].map((name) => name.split("-")[0]), "line", "surface"]);

// Declared outside `@theme` on purpose: each sits on a fill whose styles.css rule paints the ink.
const inkCarriedByFill: Record<string, RegExp> = {
  "accent-ink": /\.bg-accent\s*\{\s*color:\s*var\(--color-accent-ink\)/,
  "danger-ink": /\.bg-danger\s*\{\s*color:\s*var\(--color-danger-ink\)/,
};

const PREFIX = "bg|text|border(?:-[xytblrse])?|ring-offset|ring|divide|outline|fill|stroke|placeholder|decoration|caret|shadow|from|via|to";
const UTILITY = new RegExp(`(?<![\\w-])(?:[\\w-]+:)*(?:${PREFIX})-([a-z][a-z-]*)(?:/[\\w.\\[\\]]+)?(?![\\w-])`, "g");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("colour utilities", () => {
  it("reads the theme's colour tokens", () => {
    expect(defined.size).toBeGreaterThan(15);
    expect(defined).toContain("hairline");
    expect(defined).toContain("inset");
  });

  it("only names colour tokens the theme defines", () => {
    const unknown: string[] = [];
    for (const file of sources(src)) {
      readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        for (const [utility, name] of line.matchAll(UTILITY)) {
          if (!families.has(name.split("-")[0]) || defined.has(name) || name in inkCarriedByFill) continue;
          unknown.push(`${relative(src, file)}:${index + 1} ${utility}`);
        }
      });
    }
    expect(unknown).toEqual([]);
  });

  it("keeps the rules that paint the ink tokens no utility generates", () => {
    for (const rule of Object.values(inkCarriedByFill)) expect(css).toMatch(rule);
  });
});
