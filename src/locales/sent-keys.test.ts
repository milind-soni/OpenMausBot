// The keys the server, the shared code and the desktop app's main process send or read are catalog keys English has.
// A code the app translates (an errorKey, a notice, a routine line, an activity label or app, a card's words, a server
// line) that English lacks makes the app keep the English it was sent, silently untranslated; a key main reads that its
// packs do not keep reads as the key itself in a menu or a dialog. Keys built from a template are not read here.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import en from "./en.json";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SKIPPED = new Set(["node_modules", "dist", "vendor", "resources", "testing", "fixtures"]);

function sources(dir: string): Array<{ file: string; code: string }> {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = join(ROOT, dir, name);
    if (statSync(path).isDirectory()) return SKIPPED.has(name) ? [] : sources(relative(ROOT, path));
    if (!/\.(?:ts|mjs|cjs)$/.test(name) || /\.test\.|\.node-test\.|\.d\.m?ts$/.test(name)) return [];
    return [{ file: relative(ROOT, path).split("\\").join("/"), code: readFileSync(path, "utf8") }];
  });
}

/** The prefixes of the codes the app translates from what the server and main send, and of main's own words. */
const SENT = /^(?:serverError|chat\.notice|routines\.server|activity\.tool|activity\.app|brief|server|native|teamMove)\.[A-Za-z0-9.]*[A-Za-z0-9]$/;
/** A file's name, such as "server.log", is no key. */
const FILE = /\.(?:json|jsonl|ndjson|log|md|txt)$/;

describe("keys sent to the app or read by main", () => {
  it("are all in the English catalog", () => {
    const missing = ["server", "shared", "electron"].flatMap(sources).flatMap(({ file, code }) =>
      [...code.matchAll(/["'`]([a-z][A-Za-z]*(?:\.[A-Za-z0-9]+)+)["'`]/g)]
        .map((match) => match[1]!)
        .filter((key) => SENT.test(key) && !FILE.test(key) && !Object.hasOwn(en, key))
        .map((key) => `${file}: ${key}`));
    expect([...new Set(missing)]).toEqual([]);
  });

  it("read as words in main's menus and dialogs, never as the key", () => {
    const { englishText } = createRequire(import.meta.url)("../../electron/native-text.cjs") as { englishText: { t(key: string): string } };
    const asked = sources("electron").flatMap(({ file, code }) =>
      [...code.matchAll(/\b(?:t|nativeT)\(\s*["']([a-z][A-Za-z]*(?:\.[A-Za-z0-9]+)+)["']/g)].map((match) => ({ file, key: match[1]! })));
    expect(asked.length).toBeGreaterThan(100);
    expect(asked.filter(({ key }) => englishText.t(key) === key).map(({ file, key }) => `${file}: ${key}`)).toEqual([]);
  });
});
