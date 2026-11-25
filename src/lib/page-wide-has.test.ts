import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "styles.css"), "utf8");

/** Each `:has(` hung on the root, html or body, whatever classes, ids, attributes or pseudo-classes qualify it. */
const pageWideHas = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "")
  .match(/(?:^|[\s,{}>+~(])(?::root|html|body)(?:\.[\w-]+|#[\w-]+|\[[^\]]*\]|:(?!has\()[\w-]+(?:\([^)]*\))?)*:has\(/gm) ?? [];

// A `:has()` on the root, html or body is checked again on every node added anywhere in the page, and its match
// restyles the whole page: with several replies streaming that is a full restyle many times a second.
it("matches nothing from the root with :has()", () => {
  expect(pageWideHas(css)).toEqual([]);
});

describe("the page-wide :has() check", () => {
  it.each([
    ":root:has(.streaming) { color: red }",
    ":root.compact:has([data-chathead-tabs]) { color: red }",
    "body.compact:has(.streaming) { color: red }",
    "html#app[data-theme]:not(.x):has(.y) { color: red }",
    "a, body:has(.y) { color: red }",
  ])("catches %s", (rule) => expect(pageWideHas(rule)).toHaveLength(1));

  it.each([
    ".chat:has(.streaming) { color: red }",
    ":root .chat:has(.streaming) { color: red }",
    "body .composer.compact:has(textarea) { color: red }",
    ".tbody:has(.row) { color: red }",
  ])("lets %s through", (rule) => expect(pageWideHas(rule)).toEqual([]));
});
