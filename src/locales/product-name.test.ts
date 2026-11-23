import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import en from "./en.json";

/** Upstream's own services keep their names; they are not this product. */
const UPSTREAM_SERVICE = /\bMausBot (?:Cloud|Relay|team|accounts?)\b/g;
const NAME = /\bOpenMausBot\b|\bMausBot\b/;

const dir = new URL("./", import.meta.url);
const packs = readdirSync(dir).filter((file) => file.endsWith(".json") && file !== "en.json" && file !== "source-hashes.json")
  .map((file) => [file, JSON.parse(readFileSync(new URL(file, dir), "utf8")) as Record<string, string>] as const);

describe("the product's name in the language packs", () => {
  it("is always {app} in English, never written out", () => {
    const written = Object.entries(en as Record<string, string>)
      .filter(([, text]) => NAME.test(text.replace(UPSTREAM_SERVICE, "")))
      .map(([key]) => key);
    expect(written).toEqual([]);
  });

  it("is never written out in a translation whose English says {app}", () => {
    const written = packs.flatMap(([file, pack]) => Object.entries(pack)
      .filter(([key, text]) => !NAME.test((en as Record<string, string>)[key] ?? "") && NAME.test(text.replace(UPSTREAM_SERVICE, "")))
      .map(([key]) => `${file}: ${key}`));
    expect(written).toEqual([]);
  });
});
