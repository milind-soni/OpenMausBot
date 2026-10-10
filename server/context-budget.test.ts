import { expect, it } from "vitest";
import { compactBudget, contextWindowFor, shouldCompact, DEFAULT_CONTEXT_WINDOW } from "./context-budget.ts";

it("keeps compaction reachable below small model windows", () => {
  expect(compactBudget(8_000)).toBe(6_400);
  expect(compactBudget(2_000, 20_000)).toBe(1_800);
  expect(compactBudget(100_000, 0.7, 50_000)).toBe(45_000);
});

it("rejects invalid window values and ignores invalid provider readings", () => {
  for (const value of [NaN, Infinity, 0, -1]) {
    expect(() => compactBudget(value)).toThrow();
    expect(contextWindowFor(undefined, undefined, value)).toBe(DEFAULT_CONTEXT_WINDOW);
  }
});

it("prefers measured context, and otherwise estimates without using summed tool-round input", () => {
  expect(shouldCompact({ contextTokens: 1_000, estimatedBytes: 80_000, budget: 8_000, window: 10_000 })).toBe(false);
  expect(shouldCompact({ estimatedBytes: 40_000, budget: 8_000, window: 10_000 })).toBe(true);
});

it("does not let the regrowth floor defer compaction past window headroom", () => {
  expect(shouldCompact({ contextTokens: 9_000, estimatedBytes: 0, budget: 8_000, floor: 8_500, window: 10_000 })).toBe(true);
  expect(shouldCompact({ contextTokens: 8_600, estimatedBytes: 0, budget: 8_000, floor: 8_500, window: 10_000 })).toBe(false);
});

it("does not let the regrowth floor outrun a known native compaction threshold", () => {
  const window = 1_000_000;
  const nativeCompactAt = 200_000;
  const budget = compactBudget(window, undefined, nativeCompactAt);
  expect(budget).toBe(180_000);
  expect(shouldCompact({ contextTokens: 180_000, estimatedBytes: 0, budget, floor: 175_000, window, nativeCompactAt })).toBe(true);
  expect(shouldCompact({ contextTokens: 179_999, estimatedBytes: 0, budget, floor: 175_000, window, nativeCompactAt })).toBe(false);
});
