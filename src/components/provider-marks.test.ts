// Monochrome marks belong to --color-ink, which inverts with the skin; only real brand colours stay literal.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const MARK_FILES = readdirSync(here).filter((name) => /Mark\.tsx$|^ProviderIcons\.tsx$/.test(name));

describe("provider marks", () => {
  it("paints no mark in a colour a light skin cannot show", () => {
    expect(MARK_FILES.length).toBeGreaterThan(1);
    for (const file of MARK_FILES) {
      const source = readFileSync(join(here, file), "utf8");
      const tooLight = [...source.matchAll(/#([a-fA-F0-9]{3}|[a-fA-F0-9]{6})\b/g)]
        .map(([, hex]) => hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex)
        .filter((hex) => {
          const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
          return Math.min(r, g, b) >= 0xdd;
        });
      expect({ file, tooLight }).toEqual({ file, tooLight: [] });
    }
  });
});
