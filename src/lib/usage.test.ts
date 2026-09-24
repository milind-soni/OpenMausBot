import { describe, expect, it } from "vitest";

import { botUsage, cachedInput, headlineTokens, contextChip, contextDetail, contextShare, costCaption, formatTaskTokens, formatTokens, formatUsd, uncachedInput, lastTurnDetail, sumUsage, usageChip, usageDetail } from "./usage";

describe("usage formatting", () => {
  it("keeps output independent of the input headline, including a fully cached turn", () => {
    const usage = { input: 2048, cachedInput: 2048, output: 3, turns: 1, costUsd: null };
    expect(usageChip(usage)).toBe("0 uncached");
    expect(usageChip({ ...usage, output: 8000 })).toBe("0 uncached");
    expect(usageDetail(usage)).toBe("0 uncached input · 2k cached input · 3 output");
  });

  it("distinguishes missing cache reports from zero in last-turn details", () => {
    const usage = { input: 100, output: 8, costUsd: null, turns: 1 };
    expect(lastTurnDetail({ ...usage, lastTurn: usage }))
      .toBe("Last message: 100 input (cached + uncached) · 8 output");
    expect(lastTurnDetail({ ...usage, lastTurn: { ...usage, cachedInput: 0 } }))
      .toBe("Last message: 100 uncached input · 0 cached input · 8 output");
  });

  it("sums complete cache reports without losing an explicit zero", () => {
    const usage = { input: 100, output: 8, costUsd: null, turns: 1, cachedInput: 0 };
    expect(sumUsage([usage, { ...usage, cachedInput: 50 }]).cachedInput).toBe(50);
    expect(sumUsage([usage, { ...usage, input: 0, cachedInput: undefined }]).cachedInput).toBe(0);
    expect(sumUsage([usage, { ...usage, cachedInput: Number.NaN }]).cachedInput).toBeUndefined();
  });
  it("formats token counts compactly", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_400)).toBe("12.4k");
    expect(formatTokens(120_000)).toBe("120k");
    expect(formatTokens(2_300_000)).toBe("2.3M");
  });

  it("formats task-picker token counts without showing unused tasks", () => {
    expect(formatTaskTokens(0)).toBeNull();
    expect(formatTaskTokens(Number.NaN)).toBeNull();
    expect(formatTaskTokens(1)).toBe("1 token");
    expect(formatTaskTokens(842)).toBe("842 tokens");
    expect(formatTaskTokens(1000)).toBe("1k");
    expect(formatTaskTokens(12_350)).toBe("12.4k");
    expect(formatTaskTokens(999_949)).toBe("999.9k");
    expect(formatTaskTokens(999_950)).toBe("1M");
    expect(formatTaskTokens(123_456_789)).toBe("123.5M");
  });

  it("keeps small dollar amounts visible", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.004)).toBe("$0.004");
    expect(formatUsd(0.31)).toBe("$0.31");
  });

  it("does not throw on missing usage fields from older bots.json", () => {
    expect(formatUsd(undefined as unknown as number)).toBe("");
    expect(formatTokens(undefined as unknown as number)).toBe("0");
    expect(
      usageChip({ input: 100, output: 20, turns: 1 } as { input: number; output: number; costUsd: null; turns: number }),
    ).toBe("100 input");
  });

  it("treats NaN and Infinity cost as missing", () => {
    expect(formatUsd(Number.NaN)).toBe("");
    expect(formatUsd(Number.POSITIVE_INFINITY)).toBe("");
    expect(formatTokens(Number.NaN)).toBe("0");
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe("0");
    expect(usageChip({ input: 100, output: 20, costUsd: Number.NaN, turns: 1 })).toBe("100 input");
    expect(usageChip({ input: 100, output: 20, costUsd: Number.POSITIVE_INFINITY, turns: 1 })).toBe("100 input");
    expect(
      sumUsage([
        { input: 1, output: 1, costUsd: Number.NaN, turns: 1 },
        { input: 2, output: 2, costUsd: 0.01, turns: 1 },
      ]),
    ).toEqual({ input: 3, output: 3, costUsd: 0.01, turns: 2 });
  });

  it("does not invent a cache split when some input has no cache report", () => {
    // Missing reports make the combined cache split unknown.
    expect(sumUsage([{ input: 100, output: 10, costUsd: null, turns: 1 }, { input: 200, output: 20, cachedInput: 150, costUsd: null, turns: 1 }]))
      .toEqual({ input: 300, output: 30, costUsd: null, turns: 2 });
    expect(sumUsage([{ input: 100, output: 10, costUsd: null, turns: 1 }])).toEqual({ input: 100, output: 10, costUsd: null, turns: 1 });
    // Zero cache is reported explicitly; missing cache is combined input.
    expect(usageDetail({ input: 88_200, output: 1_200, cachedInput: 79_000, costUsd: null, turns: 5 })).toBe("9.2k uncached input · 79k cached input · 1.2k output");
    expect(usageDetail({ input: 900, output: 50, costUsd: null, turns: 1 })).toBe("900 input (cached + uncached) · 50 output");
    expect(usageDetail({ input: 900, output: 50, cachedInput: 0, costUsd: null, turns: 1 })).toBe("900 uncached input · 0 cached input · 50 output");
    // a cached figure can never exceed the input it is part of, or go negative
    expect(cachedInput({ input: 100, output: 0, cachedInput: 250, costUsd: null, turns: 1 })).toBe(100);
    expect(cachedInput({ input: 100, output: 0, cachedInput: -3, costUsd: null, turns: 1 })).toBe(0);
    expect(cachedInput({ input: 100, output: 0, cachedInput: Number.NaN, costUsd: null, turns: 1 })).toBe(0);
  });

  it("builds the chip: tokens always, cost only when known, nothing when unused", () => {
    expect(usageChip({ input: 0, output: 0, costUsd: null, turns: 0 })).toBe("");
    expect(usageChip({ input: 10_000, output: 2_400, costUsd: null, turns: 3 })).toBe("10k input");
    expect(usageChip({ input: 10_000, output: 2_400, costUsd: 0.06, turns: 3 })).toBe("$0.06");
  });

  it("sums across tasks and leaves cost null until one reports it", () => {
    expect(sumUsage([{ input: 1, output: 1, costUsd: null, turns: 1 }, undefined, { input: 2, output: 2, costUsd: null, turns: 1 }])).toEqual({
      input: 3,
      output: 3,
      costUsd: null,
      turns: 2,
    });
    expect(
      botUsage({
        tasks: [
          { threadId: "a", title: "", createdAt: 0, usage: { input: 5, output: 5, costUsd: 0.01, turns: 1 } },
          { threadId: "b", title: "", createdAt: 0 },
          { threadId: "c", title: "", createdAt: 0, usage: { input: 5, output: 5, costUsd: null, turns: 2 } },
        ],
      }),
    ).toEqual({ input: 10, output: 10, costUsd: 0.01, turns: 3 });
  });

  it("captions cost by billing", () => {
    expect(costCaption("subscription")).toMatch(/not billed/);
    expect(costCaption("metered")).toMatch(/API key/);
    expect(costCaption(undefined)).toMatch(/reported/);
  });

  it("keeps aggregate token counters distinct from input-only chat chips", () => {
    const longThread = { input: 1_900_000, output: 12_000, cachedInput: 1_862_000, costUsd: null, turns: 12 };
    expect(headlineTokens(longThread)).toBe(50_000);
    // an engine that never reported a cached share has only the raw total
    expect(headlineTokens({ input: 1_900_000, output: 12_000, costUsd: null, turns: 12 })).toBe(1_912_000);
  });

  it("headlines cost, otherwise input without mixing in output", () => {
    // Input includes the full request, not only text typed by the person.
    const longThread = { input: 1_900_000, output: 12_000, cachedInput: 1_862_000, costUsd: null, turns: 12 };
    expect(uncachedInput(longThread)).toBe(38_000);
    expect(usageChip(longThread)).toBe("38k uncached");
    expect(usageChip({ ...longThread, costUsd: 4.2 })).toBe("$4.20");
    // An engine without cache reports shows total input.
    expect(usageChip({ input: 1_900_000, output: 12_000, costUsd: null, turns: 12 })).toBe("1.9M input");
    expect(usageChip({ input: 0, output: 0, costUsd: null, turns: 0 })).toBe("");
  });

  it("reads the context figure against the window with ccusage's thresholds", () => {
    const base = { input: 0, output: 0, costUsd: null, turns: 1 };
    expect(contextShare(base)).toBeNull();
    expect(contextShare({ ...base, context: { tokens: 142_000 } })).toEqual({ tokens: 142_000, window: undefined, percent: undefined, tone: "quiet" });
    expect(contextShare({ ...base, context: { tokens: 142_000, window: 272_000 } })).toMatchObject({ percent: 52, tone: "warning" });
    expect(contextShare({ ...base, context: { tokens: 230_000, window: 272_000 } })).toMatchObject({ percent: 85, tone: "danger" });
    expect(contextShare({ ...base, context: { tokens: 40_000, window: 200_000 } })).toMatchObject({ percent: 20, tone: "quiet" });
    expect(contextChip({ ...base, context: { tokens: 142_000, window: 272_000 } })).toBe("ctx 52%");
    expect(contextChip({ ...base, context: { tokens: 142_000 } })).toBe("ctx 142k");
    expect(contextDetail({ ...base, context: { tokens: 142_000, window: 272_000 } })).toBe("Context 142k (52% of 272k)");
    expect(contextDetail({ ...base, context: { tokens: 142_000 } })).toBe("Context 142k");
  });

  it("says what the last message alone cost", () => {
    expect(lastTurnDetail({ input: 0, output: 0, costUsd: null, turns: 0 })).toBeNull();
    expect(lastTurnDetail({ input: 500_000, output: 5_000, costUsd: null, turns: 3, lastTurn: { input: 210_000, output: 1_200, cachedInput: 209_000, costUsd: null } }))
      .toBe("Last message: 1k uncached input · 209k cached input · 1.2k output");
  });
});
