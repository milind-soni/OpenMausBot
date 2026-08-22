import { describe, expect, it } from "vitest";

import { formatTokens } from "./format-tokens";

describe("formatTokens", () => {
  it("hides zero, negatives and non-finite values entirely", () => {
    expect(formatTokens(0)).toBeNull();
    expect(formatTokens(-5)).toBeNull();
    expect(formatTokens(Number.NaN)).toBeNull();
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("spells out sub-thousand counts", () => {
    expect(formatTokens(1)).toBe("1 token");
    expect(formatTokens(2)).toBe("2 tokens");
    expect(formatTokens(842)).toBe("842 tokens");
    expect(formatTokens(999)).toBe("999 tokens");
  });

  it("switches to k exactly at 1000, without a trailing .0", () => {
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(1049)).toBe("1k");
    expect(formatTokens(1050)).toBe("1.1k");
    expect(formatTokens(12_300)).toBe("12.3k");
    expect(formatTokens(12_349)).toBe("12.3k");
    expect(formatTokens(12_350)).toBe("12.4k");
  });

  it("promotes to M exactly where k-rounding would reach 1000k", () => {
    expect(formatTokens(999_949)).toBe("999.9k");
    expect(formatTokens(999_950)).toBe("1M");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_240_000)).toBe("1.2M");
    expect(formatTokens(1_250_000)).toBe("1.3M");
    expect(formatTokens(123_456_789)).toBe("123.5M");
  });
});
