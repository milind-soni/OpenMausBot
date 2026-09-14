import { describe, expect, it } from "vitest";

import { MAUS_COLOR_HEX, mausColorHex } from "./maus-colors.ts";

describe("bot colour palette", () => {
  it("maps every stored colour name to a #rrggbb swatch", () => {
    for (const [name, hex] of Object.entries(MAUS_COLOR_HEX)) {
      expect(mausColorHex(name)).toBe(hex);
      expect(hex).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it("answers undefined for anything that is not a palette name", () => {
    for (const bad of [undefined, null, "", "magenta", "#E78531", "constructor", "__proto__"]) {
      expect(mausColorHex(bad)).toBeUndefined();
    }
  });
});
