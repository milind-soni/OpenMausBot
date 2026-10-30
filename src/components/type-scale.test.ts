import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const FRACTIONAL_SIZE = /text-\[\d+\.\d+px\]|font-size:\s*\d+\.\d+px|fontSize:\s*\d+\.\d+(?![\d.])/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(tsx?|css)$/.test(entry.name) ? [path] : [];
  });
}

describe("type scale", () => {
  it("sizes text in whole pixels, so neighbouring steps stay distinct", () => {
    const offenders = sourceFiles(srcRoot).flatMap((file) =>
      (readFileSync(file, "utf8").match(FRACTIONAL_SIZE) ?? []).map((size) => `${relative(srcRoot, file)}: ${size}`),
    );
    expect(offenders).toEqual([]);
  });
});
