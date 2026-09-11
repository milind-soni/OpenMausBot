import { describe, expect, it } from "vitest";

import { isLocalInjectModelId } from "../../shared/compact-around";
import { botUsage, cachedInput, costCaption, fillChip, formatTaskTokens, formatTokens, formatUsd, sumUsage, usageChip, usageDetail } from "./usage";

describe("usage formatting", () => {
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
    ).toEqual({ input: 3, output: 3, costUsd: 0.01, turns: 2 });
  });

  it("carries the cached share through sums and names it in the breakdown", () => {
    // records from before the field existed simply don't contribute to it
    expect(sumUsage([{ input: 100, output: 10, costUsd: null, turns: 1 }, { input: 200, output: 20, cachedInput: 150, costUsd: null, turns: 1 }]))
      .toEqual({ input: 300, output: 30, cachedInput: 150, costUsd: null, turns: 2 });
    expect(sumUsage([{ input: 100, output: 10, costUsd: null, turns: 1 }])).toEqual({ input: 100, output: 10, costUsd: null, turns: 1 });
    // the headline stays the whole figure; the split is what explains it
    expect(usageDetail({ input: 88_200, output: 1_200, cachedInput: 79_000, costUsd: null, turns: 5 })).toBe("88.2k in (79k cached) · 1.2k out");
    expect(usageDetail({ input: 900, output: 50, costUsd: null, turns: 1 })).toBe("900 in · 50 out");
    expect(usageDetail({ input: 900, output: 50, cachedInput: 0, costUsd: null, turns: 1 })).toBe("900 in · 50 out");
    // a cached figure can never exceed the input it is part of, or go negative
    expect(cachedInput({ input: 100, output: 0, cachedInput: 250, costUsd: null, turns: 1 })).toBe(100);
    expect(cachedInput({ input: 100, output: 0, cachedInput: -3, costUsd: null, turns: 1 })).toBe(0);
    expect(cachedInput({ input: 100, output: 0, cachedInput: Number.NaN, costUsd: null, turns: 1 })).toBe(0);
  });

  it("builds the chip: tokens always, cost only when known, nothing when unused", () => {
    expect(usageChip({ input: 0, output: 0, costUsd: null, turns: 0 })).toBe("");
    expect(usageChip({ input: 10_000, output: 2_400, costUsd: null, turns: 3 })).toBe("12.4k tok");
    expect(usageChip({ input: 10_000, output: 2_400, costUsd: 0.06, turns: 3 })).toBe("12.4k tok · $0.06");
  });

  it("shows live fill versus the refresh window for local models", () => {
    expect(fillChip(2_080, 32_000)).toBe("2.1k / 32k");
    expect(fillChip(140_761, 128_000)).toBe("141k / 128k");
    expect(fillChip(0, 32_000)).toBe("0 / 32k");
    expect(fillChip(10, 0)).toBe("");
  });

  it("recognizes injected local-host model ids", () => {
    expect(isLocalInjectModelId("unsloth::glm-uncensored")).toBe(true);
    expect(isLocalInjectModelId("ollama::llama3.2")).toBe(true);
    expect(isLocalInjectModelId("omlx::qwen")).toBe(true);
    expect(isLocalInjectModelId("lmstudio::foo")).toBe(true);
    expect(isLocalInjectModelId("exo::bar")).toBe(true);
    expect(isLocalInjectModelId("gpt-4o")).toBe(false);
    expect(isLocalInjectModelId("grok-4")).toBe(false);
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
});
