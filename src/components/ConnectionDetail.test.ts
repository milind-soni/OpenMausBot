import { describe, expect, it } from "vitest";

import { addressPreview } from "./ConnectionDetail";

describe("connection address preview", () => {
  it.each([
    ["abcdefghij", "abcd…hij"],
    ["abcdefghijklmnop", "abcd…nop"],
  ])("keeps a hidden gap in a %s value", (value, expected) => {
    const preview = addressPreview(value);

    expect(preview).toBe(expected);
    expect(preview.replace("…", "")).not.toBe(value);
  });
});
