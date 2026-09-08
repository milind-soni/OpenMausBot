import { describe, expect, it } from "vitest";

import {
  countWords,
  estimateTokens,
  formatTokenCount,
  formatWordCount,
  getTextMetrics,
} from "./token-estimator";

describe("countWords", () => {
  it("returns 0 for empty or whitespace-only inputs", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   ")).toBe(0);
    expect(countWords("\n\t  \n")).toBe(0);
    expect(countWords(null)).toBe(0);
    expect(countWords(undefined)).toBe(0);
  });

  it("counts words across spaces, tabs, and newlines", () => {
    expect(countWords("Hello")).toBe(1);
    expect(countWords("Hello world")).toBe(2);
    expect(countWords("  The   quick\tbrown\nfox  ")).toBe(4);
    expect(countWords("one\ntwo\nthree\nfour\nfive")).toBe(5);
  });
});

describe("estimateTokens", () => {
  it("returns 0 for empty or omitted inputs", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("   ")).toBe(0);
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
  });

  it("estimates token counts for plain English sentences", () => {
    const tokens = estimateTokens("Hello world");
    expect(tokens).toBeGreaterThanOrEqual(2);
    expect(tokens).toBeLessThanOrEqual(4);

    const sentenceTokens = estimateTokens("The quick brown fox jumps over the lazy dog.");
    expect(sentenceTokens).toBeGreaterThanOrEqual(9);
    expect(sentenceTokens).toBeLessThanOrEqual(14);
  });

  it("accounts for code syntax, operators, and punctuation", () => {
    const code = "function add(a: number, b: number): number { return a + b; }";
    const tokens = estimateTokens(code);
    expect(tokens).toBeGreaterThan(15);
    expect(tokens).toBeLessThan(35);
  });

  it("estimates tokens for CJK text", () => {
    const tokens = estimateTokens("你好世界");
    // 4 CJK ideographs should estimate around 4-7 tokens
    expect(tokens).toBeGreaterThanOrEqual(4);
    expect(tokens).toBeLessThanOrEqual(8);
  });
});

describe("getTextMetrics", () => {
  it("returns zero metrics for empty strings", () => {
    expect(getTextMetrics("")).toEqual({
      words: 0,
      characters: 0,
      estimatedTokens: 0,
    });
    expect(getTextMetrics(null)).toEqual({
      words: 0,
      characters: 0,
      estimatedTokens: 0,
    });
  });

  it("returns populated metrics for text content", () => {
    const sample = "Build a bot";
    const metrics = getTextMetrics(sample);
    expect(metrics.words).toBe(3);
    expect(metrics.characters).toBe(sample.length);
    expect(metrics.estimatedTokens).toBeGreaterThanOrEqual(3);
  });
});

describe("formatTokenCount", () => {
  it("formats counts under 1,000 with '~' and 'tok'", () => {
    expect(formatTokenCount(42)).toBe("~42 tok");
    expect(formatTokenCount(999)).toBe("~999 tok");
  });

  it("formats counts between 1,000 and 10,000 with 1 decimal place if needed", () => {
    expect(formatTokenCount(1000)).toBe("~1k tok");
    expect(formatTokenCount(1500)).toBe("~1.5k tok");
    expect(formatTokenCount(3200)).toBe("~3.2k tok");
  });

  it("formats counts 10,000 and above rounded to nearest thousand", () => {
    expect(formatTokenCount(10000)).toBe("~10k tok");
    expect(formatTokenCount(32400)).toBe("~32k tok");
    expect(formatTokenCount(128000)).toBe("~128k tok");
  });
});

describe("formatWordCount", () => {
  it("formats singular word count", () => {
    expect(formatWordCount(1)).toBe("1 word");
  });

  it("formats plural word counts", () => {
    expect(formatWordCount(0)).toBe("0 words");
    expect(formatWordCount(2)).toBe("2 words");
    expect(formatWordCount(150)).toBe("150 words");
  });
});
