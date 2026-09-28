// styles.css takes the browser outline off text fields, because Chromium
// matches :focus-visible on a pointer click and drew a sharp rectangle inside
// the composer's rounded pill; a text field shows focus on its own border
// instead. The rule was written as `:is(input, textarea, select)`, which also
// caught checkboxes, radios, sliders, colour wells and file pickers. Those
// have no border of their own to repaint, so tabbing onto one showed nothing
// at all (WCAG 2.4.7). That failure is silent, so it gets a test.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../styles.css"), "utf8");

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

const withoutComments = unlayered(css).replace(/\/\*[\s\S]*?\*\//g, "");

/** Selectors of the unlayered rules that take the outline away. */
const outlineRemovers = [...withoutComments.matchAll(/([^{}]+)\{([^}]*)\}/g)]
  .filter(([, , body]) => /(?:^|;)\s*outline\s*:\s*(?:none|0)\s*(?:;|$)/.test(body))
  .map(([, selector]) => selector.trim());

// Inputs that are not text fields: nothing else draws their focus.
const CONTROLS = ["checkbox", "radio", "range", "color", "file"];

describe("keyboard focus on form controls", () => {
  it("keeps the global focus ring", () => {
    expect(withoutComments).toMatch(/(?:^|\})\s*:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--color-focus\)/);
  });

  it("still takes the outline off text fields, so the composer pill stays clean", () => {
    const fieldRule = outlineRemovers.find((selector) => selector.includes("textarea"));
    expect(fieldRule).toBeDefined();
    expect(fieldRule).toContain("input");
  });

  it.each(CONTROLS)("never takes the outline off a %s input", (type) => {
    for (const selector of outlineRemovers) {
      // every `input` a remover names must be narrowed away from this type
      for (const [compound] of selector.matchAll(/(?<![\w-])input(?![\w-])(?::not\((?:[^()]|\([^()]*\))*\))?/g)) {
        expect(compound, selector).toContain(`[type="${type}"]`);
      }
    }
  });
});
