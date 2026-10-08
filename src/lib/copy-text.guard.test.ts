import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Every clipboard write goes through copyText, which falls back to the
// desktop bridge and reports a failure. A direct navigator.clipboard.writeText
// is refused on pages Chromium does not let write (and on some it never
// settles), so a copy button calling it fails silently.
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = "lib/copy-text.ts";
const DIRECT_WRITE = /navigator\s*\??\.\s*clipboard\s*\??\.\s*writeText/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("clipboard writes", () => {
  const files = sourceFiles(SRC).map((path) => ({ name: relative(SRC, path).split("\\").join("/"), text: readFileSync(path, "utf8") }));

  it("go through copyText, never navigator.clipboard.writeText directly", () => {
    const direct = files.filter((file) => file.name !== HELPER && DIRECT_WRITE.test(file.text)).map((file) => file.name);
    expect(direct).toEqual([]);
  });

  it("scans the real sources: the helper itself is the one direct write it finds", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.filter((file) => DIRECT_WRITE.test(file.text)).map((file) => file.name)).toEqual([HELPER]);
    for (const sample of ["navigator.clipboard.writeText(x)", "navigator.clipboard?.writeText(x)", "navigator?.clipboard?.writeText", "navigator.clipboard\n      .writeText(code)"]) {
      expect(DIRECT_WRITE.test(sample), sample).toBe(true);
    }
  });
});
