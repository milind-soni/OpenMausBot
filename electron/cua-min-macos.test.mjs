import { describe, expect, it } from "vitest";
import { CUA_MIN_MACOS, LEGACY_MIN_MACOS, macDriverKind } from "./cua-min-macos.mjs";

describe("macOS driver routing", () => {
  it("keeps the upstream driver floor and names the fallback floor", () => {
    expect(CUA_MIN_MACOS).toBe(15);
    expect(LEGACY_MIN_MACOS).toBe(12.3);
  });

  it.each([
    ["20.6.0", "unsupported"],
    ["21.3.0", "unsupported"],
    ["21.4.0", "legacy"],
    ["22.6.0", "legacy"],
    ["23.6.0", "legacy"],
    ["24.0.0", "cua"],
    ["25.0.0", "cua"],
  ])("routes Darwin %s to %s", (release, kind) => {
    expect(macDriverKind(release)).toBe(kind);
  });
});
