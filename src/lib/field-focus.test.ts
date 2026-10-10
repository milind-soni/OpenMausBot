// styles.css strips the browser outline from every text field, because
// Chromium matches :focus-visible on a pointer click and drew a sharp
// rectangle inside the composer's rounded pill. That rule left each field to
// supply its own focus state, and most either added none or added
// `focus:border-hairline`, a step too small to see. A field a keyboard user
// cannot find fails WCAG 2.4.7 without any error, so it gets a test.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const src = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(src, "styles.css"), "utf8");

/** The stylesheet with every `@layer … { … }` block cut out, so what is left
 * is the unlayered CSS that outranks Tailwind's utilities. */
function unlayered(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const start = source.indexOf("@layer", i);
    if (start === -1) return out + source.slice(i);
    out += source.slice(i, start);
    const open = source.indexOf("{", start);
    const semi = source.indexOf(";", start);
    if (semi !== -1 && semi < open) {
      i = semi + 1;
      continue;
    }
    let depth = 0;
    let j = open;
    for (; j < source.length; j++) {
      if (source[j] === "{") depth++;
      else if (source[j] === "}" && --depth === 0) break;
    }
    i = j + 1;
  }
  return out;
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("text field focus", () => {
  it("still keeps the browser outline off text fields", () => {
    // non-text inputs (checkbox, radio, ...) are excluded so they keep the ring
    expect(css).toMatch(/:is\(input(?::not\([^)]*\))?, textarea, select\):focus-visible\s*\{\s*outline:\s*none;/);
  });

  it("paints a focused field's own border in the focus colour, above every utility", () => {
    const rule = unlayered(css).match(/:is\(input, textarea, select\):focus-visible(?::not\([^)]*\))?\s*\{([^}]*)\}/g) ?? [];
    expect(rule.join("\n")).toMatch(/border-color:\s*var\(--color-focus\)/);
  });

  it("leaves a field that reports an error in its error colour while focused", () => {
    // an invalid field marks itself with aria-invalid and a danger border;
    // the focus colour must not paint over the red while the user fixes it
    const selectors = [...unlayered(css).matchAll(/([^{}]+)\{[^}]*border-color:\s*var\(--color-focus\)[^}]*\}/g)].map((match) => match[1].trim());
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) expect(selector).toContain(':not([aria-invalid="true"])');
  });

  it("never fades focus to the resting hairline", () => {
    const faint: string[] = [];
    for (const file of sources(src)) {
      readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        for (const [utility] of line.matchAll(/focus(?:-within)?:border-hairline(?:\/\d+)?(?![\w-])/g)) {
          faint.push(`${relative(src, file)}:${index + 1} ${utility}`);
        }
      });
    }
    expect(faint).toEqual([]);
  });
});
