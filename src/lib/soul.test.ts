import { describe, expect, it } from "vitest";

import { firstSentence, soulPatchFor, utf8Bytes } from "./soul";

describe("utf8Bytes", () => {
  it("counts bytes, not characters", () => {
    expect(utf8Bytes("")).toBe(0);
    expect(utf8Bytes("abc")).toBe(3);
    expect(utf8Bytes("é")).toBe(2);
    expect(utf8Bytes("🐭")).toBe(4);
  });
});

describe("firstSentence", () => {
  it("returns the text up to the first sentence end, trimmed", () => {
    expect(firstSentence("Files bugs. Never noise.")).toBe("Files bugs.");
    expect(firstSentence("  Tracks Discord!\nMore.")).toBe("Tracks Discord!");
    expect(firstSentence("No punctuation here")).toBe("No punctuation here");
  });

  it("stops at the first line break and caps the length", () => {
    expect(firstSentence("Line one\nLine two.")).toBe("Line one");
    expect(firstSentence("a".repeat(500), 200)).toHaveLength(200);
    expect(firstSentence("")).toBe("");
  });
});

describe("soulPatchFor", () => {
  it("returns a patch for a draft exactly at the byte limit", () => {
    const value = "a".repeat(10);
    expect(soulPatchFor(value, 10)).toEqual({ soul: value });
  });

  it("returns null one byte over the limit, even via a multi-byte character", () => {
    // "é" is 2 bytes; 9 ascii bytes + 2 = 11, one over a limit of 10.
    const value = `${"a".repeat(9)}é`;
    expect(utf8Bytes(value)).toBe(11);
    expect(soulPatchFor(value, 10)).toBeNull();
  });

  it("returns an empty patch for an empty draft", () => {
    expect(soulPatchFor("", 10)).toEqual({ soul: "" });
  });
});
