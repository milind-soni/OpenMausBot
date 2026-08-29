import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { titleBarOverlayForColors } from "./title-bar-theme.mjs";

describe("Windows title-bar theme", () => {
  it("does not import packages that the Electron main-process bundle excludes", () => {
    const source = readFileSync(new URL("./title-bar-theme.mjs", import.meta.url), "utf8");
    expect(source).not.toMatch(/from\s+["'](?!\.\.?\/|node:)[^"']+["']/);
  });

  it("turns the renderer's active skin colors into a Windows title-bar overlay", () => {
    expect(titleBarOverlayForColors({ background: "#f5f1eb", foreground: "#1a1a18" })).toEqual({
      color: "#f5f1eb",
      symbolColor: "#1a1a18",
      height: 40,
    });
  });

  it("preserves the existing Midnight title-bar palette", () => {
    expect(titleBarOverlayForColors({ background: "#070707", foreground: "#b5b5b5" })).toEqual({
      color: "#070707",
      symbolColor: "#b5b5b5",
      height: 40,
    });
  });

  it("rejects malformed renderer colors instead of passing them to Electron", () => {
    expect(() =>
      titleBarOverlayForColors({ background: "black", foreground: "#fff" }),
    ).toThrow(/invalid title-bar colors/i);
  });
});
