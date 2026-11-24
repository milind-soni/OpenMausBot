import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "styles.css"), "utf8");

// A `:has()` on the root, html or body is checked again on every node added anywhere in the page, and its match
// restyles the whole page: with several replies streaming that is a full restyle many times a second.
it("matches nothing from the root with :has()", () => {
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "").match(/(?:^|[\s,{}>+~(])(?::root|html|body)(?:\[[^\]]*\]|:[\w-]+(?:\([^)]*\))?)*:has\(/gm) ?? [];
  expect(rules).toEqual([]);
});
