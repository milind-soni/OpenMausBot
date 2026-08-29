import { describe, expect, it } from "vitest";

import { botUsage, clearLiveUsage, costCaption, costMenuLabel, formatTokens, formatUsd, hasCostMenuData, sumUsage, taskUsageWithLive, tokenUsageLabel, tokenUsagePresentation, usageChip, usageCost } from "./usage";

describe("usage formatting", () => {
  it("renders actual, expected, batch, and daily cost totals in the menu", () => {
    expect(costMenuLabel({
      allTime: { actualUsd: 0.42, predictedUsd: 0.55 },
      batch: { actualUsd: 0.12, predictedUsd: 0.18 },
      daily: { actualUsd: 1.2, predictedUsd: 1.5 },
    })).toBe("$0.42 actual / ~$0.55 expected · batch $0.12 actual / ~$0.18 expected · today $1.20 actual / ~$1.50 expected");
  });

  it("does not let an empty ledger snapshot hide task usage", () => {
    expect(hasCostMenuData({
      allTime: { actualUsd: null, predictedUsd: null },
      batch: { actualUsd: null, predictedUsd: null },
      daily: { actualUsd: null, predictedUsd: null },
    })).toBe(false);
    expect(hasCostMenuData({
      allTime: { actualUsd: null, predictedUsd: 0.01 },
      batch: { actualUsd: null, predictedUsd: null },
      daily: { actualUsd: null, predictedUsd: null },
    })).toBe(true);
  });

  it("formats token counts compactly", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_400)).toBe("12.4k");
    expect(formatTokens(120_000)).toBe("120k");
    expect(formatTokens(2_300_000)).toBe("2.3M");
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
    ).toBe("120 tok");
  });

  it("treats NaN and Infinity cost as missing", () => {
    expect(formatUsd(Number.NaN)).toBe("");
    expect(formatUsd(Number.POSITIVE_INFINITY)).toBe("");
    expect(formatTokens(Number.NaN)).toBe("0");
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe("0");
    expect(usageChip({ input: 100, output: 20, costUsd: Number.NaN, turns: 1 })).toBe("120 tok");
    expect(usageChip({ input: 100, output: 20, costUsd: Number.POSITIVE_INFINITY, turns: 1 })).toBe("120 tok");
    expect(
      sumUsage([
        { input: 1, output: 1, costUsd: Number.NaN, turns: 1 },
        { input: 2, output: 2, costUsd: 0.01, turns: 1 },
      ]),
    ).toEqual({ input: 3, output: 3, costUsd: 0.01, turns: 2, tokenTurns: 2 });
  });

  it("builds the chip: tokens always, cost only when known, nothing when unused", () => {
    expect(usageChip({ input: 0, output: 0, costUsd: null, turns: 0 })).toBe("");
    expect(usageChip({ input: 10_000, output: 2_400, costUsd: null, turns: 3 })).toBe("12.4k tok");
    expect(usageChip({ input: 10_000, output: 2_400, costUsd: 0.06, turns: 3 })).toBe("12.4k tok · $0.06");
  });

  it("shows a clearly marked best estimate when an engine omits token counts", () => {
    const usage = { input: 0, output: 0, costUsd: null, turns: 2, tokenTurns: 0 };
    expect(tokenUsageLabel(usage)).toBe("~4k (est.)");
    expect(usageChip(usage)).toBe("~4k tok · est");
  });

  it("fills missing turns from the measured per-turn average and marks the result estimated", () => {
    const usage = { input: 10_000, output: 2_400, costUsd: null, turns: 3, tokenTurns: 2 };
    expect(tokenUsageLabel(usage)).toBe("~18.6k (est.)");
    expect(usageChip(usage)).toBe("~18.6k tok · est");
  });

  it("uses persisted missing-turn estimates and labels their provenance", () => {
    const usage = { input: 800, output: 200, costUsd: null, turns: 3, tokenTurns: 1, estimatedTokens: 4_000 };
    expect(tokenUsagePresentation(usage)).toEqual({
      kind: "estimated",
      tokens: 5_000,
      reportedTurns: 1,
      totalTurns: 3,
      estimateSource: "persisted",
    });
    expect(tokenUsageLabel(usage)).toBe("~5k (est.)");
  });

  it("sums across tasks and leaves cost null until one reports it", () => {
    expect(sumUsage([{ input: 1, output: 1, costUsd: null, turns: 1 }, undefined, { input: 2, output: 2, costUsd: null, turns: 1 }])).toEqual({
      input: 3,
      output: 3,
      costUsd: null,
      turns: 2,
      tokenTurns: 2,
    });
    expect(
      botUsage({
        tasks: [
          { threadId: "a", title: "", createdAt: 0, usage: { input: 5, output: 5, costUsd: 0.01, turns: 1 } },
          { threadId: "b", title: "", createdAt: 0 },
          { threadId: "c", title: "", createdAt: 0, usage: { input: 5, output: 5, costUsd: null, turns: 2 } },
        ],
      }),
    ).toEqual({ input: 10, output: 10, costUsd: 0.01, turns: 3, tokenTurns: 3 });
  });

  it("captions cost by billing", () => {
    expect(costCaption("subscription")).toMatch(/not billed/);
    expect(costCaption("metered")).toMatch(/API key/);
    expect(costCaption(undefined)).toMatch(/reported/);
  });

  it("projects live usage without mutating the settled task tally", () => {
    const settled = { input: 1_000, output: 200, costUsd: null, turns: 1, tokenTurns: 1 };
    expect(taskUsageWithLive(settled, { input: 500, output: 100, scope: "turn" })).toEqual({
      input: 1_500,
      output: 300,
      costUsd: null,
      turns: 2,
      tokenTurns: 2,
    });
    expect(taskUsageWithLive(settled, { input: 1_450, output: 275, scope: "thread" })).toEqual({
      input: 1_450,
      output: 275,
      costUsd: null,
      turns: 2,
      tokenTurns: 2,
    });
    expect(settled).toEqual({ input: 1_000, output: 200, costUsd: null, turns: 1, tokenTurns: 1 });
  });

  it("does not overlay a final cumulative usage event onto the settled header value", () => {
    const settled = { input: 1_000, output: 200, costUsd: 0.01, turns: 1, tokenTurns: 1 };
    const live = { input: 1_000, output: 200, scope: "thread" as const };

    const remaining = clearLiveUsage({ "thread-1": live }, "thread-1");
    expect(taskUsageWithLive(settled, remaining["thread-1"])).toEqual(settled);
  });

  it("updates the horizontal header cost from live usage using the selected model card", () => {
    const settled = { input: 1_000, output: 200, costUsd: null, turns: 1, tokenTurns: 1 };
    const live = { input: 1_500, output: 300, scope: "thread" as const };
    const pricing = { inputUsdPerMillion: 2, outputUsdPerMillion: 4, source: "fixture-rate-card" };
    const projected = taskUsageWithLive(settled, live);
    if (!projected) throw new Error("live usage should project onto a settled task");

    expect(usageChip(projected, usageCost(settled, live, pricing))).toContain("~$0.001");
    expect(clearLiveUsage({ "thread-1": live }, "thread-1")).toEqual({});
  });

  it("prices cached input at the cache rate and applies long-context multipliers", () => {
    const pricing = {
      inputUsdPerMillion: 4,
      cachedInputUsdPerMillion: 0.4,
      outputUsdPerMillion: 20,
      longContext: { thresholdTokens: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
      source: "Shane rate card",
    };
    const exact = usageCost(undefined, { input: 100_000, output: 10_000, cachedInput: 50_000, scope: "turn" }, pricing);
    expect(exact).toMatchObject({ kind: "estimated", usd: 0.42, precision: "exact" });
    const qualified = usageCost(undefined, { input: 100_000, output: 10_000, scope: "turn" }, pricing);
    expect(qualified).toMatchObject({ kind: "estimated", usd: 0.6, precision: "qualified", qualification: "cached_input_not_reported" });
    const long = usageCost(undefined, { input: 300_000, output: 10_000, cachedInput: 0, scope: "turn" }, pricing);
    expect(long).toMatchObject({ kind: "estimated", usd: 2.7, precision: "exact" });
  });
});
