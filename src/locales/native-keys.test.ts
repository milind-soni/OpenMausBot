import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import en from "./en.json";
import { locales } from "./index";

const ELECTRON = fileURLToPath(new URL("../../electron/", import.meta.url));
const code = readdirSync(ELECTRON)
  .filter((name) => /\.(?:mjs|cjs)$/.test(name) && !/\.test\.|\.node-test\./.test(name))
  .map((name) => readFileSync(join(ELECTRON, name), "utf8"))
  .join("\n");
const used = new Set([...code.matchAll(/["'](native\.[A-Za-z0-9.]+)["']/g)].map((match) => match[1]!));
const catalog = Object.keys(en).filter((key) => key.startsWith("native."));

it("every native key main asks for is in the English catalog", () => {
  expect([...used].filter((key) => !Object.hasOwn(en, key))).toEqual([]);
});

it("every native key in the English catalog is one main asks for", () => {
  expect(catalog.filter((key) => !used.has(key))).toEqual([]);
});

it("main reads the same pack for each language code as the window does", () => {
  const { LOCALE_ALIASES, nativeLanguage } = createRequire(import.meta.url)("../../electron/native-text.cjs") as {
    LOCALE_ALIASES: Record<string, string>;
    nativeLanguage(code: string): string | null;
  };
  const files = new Set(readdirSync(fileURLToPath(new URL(".", import.meta.url))).filter((name) => /^[a-z-]+\.json$/.test(name) && name !== "source-hashes.json").map((name) => name.slice(0, -5)));
  const aliases = Object.keys(locales).filter((tag) => !files.has(tag)).sort();
  expect(Object.keys(LOCALE_ALIASES).sort()).toEqual(aliases);
  for (const tag of Object.keys(locales)) {
    const pack = nativeLanguage(tag);
    expect(pack, tag).not.toBeNull();
    expect(locales[pack!], tag).toBe(locales[tag]);
  }
});
