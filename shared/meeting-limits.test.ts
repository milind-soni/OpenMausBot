import { describe, expect, it } from "vitest";
import { normalizeMeetingLimits, meetingBudgetSnapshot, meetingBudgetText, usageTokens } from "./meeting-limits.ts";

describe("autonomous meeting allowances", () => {
  it("keeps 16/22 by default and replaces omitted dimensions for custom limits", () => {
    expect(normalizeMeetingLimits()).toEqual({ replies: { wrapUpAfter: 16, hardStop: 22 } });
    expect(normalizeMeetingLimits({ time: { seconds: 300 } })).toEqual({ time: { seconds: 300, wrapUpSeconds: 210 } });
  });
  it.each([{}, { unknown: 1 }, { replies: { hardStop: 0 } }, { replies: { hardStop: 5, wrapUpAfter: 5 } },
    { time: { seconds: 1.5 } }, { time: { seconds: Infinity } }, { tokens: { hardStop: -1 } },
    { tokens: { hardStop: 10, count: "output" } }, { cost: { hardStopUsd: "1" } },
    { cost: { hardStopUsd: 1, wrapUpUsd: 1 } }])("rejects invalid allowances %j", value => {
    expect(() => normalizeMeetingLimits(value)).toThrow();
  });
  it("counts all input and output without counting cached input twice", () => {
    expect(usageTokens({ input: 100, cachedInput: 90, output: 20 })).toBe(120);
    expect(usageTokens({ input: NaN, output: -1 })).toBe(0);
  });
  const limits = normalizeMeetingLimits({ replies: { hardStop: 10, wrapUpAfter: 6 }, tokens: { hardStop: 1000, wrapUpAt: 700 },
    time: { seconds: 300, wrapUpSeconds: 210 }, cost: { hardStopUsd: 0.50, wrapUpUsd: 0.35 } });
  it.each([{ replies: 6 }, { tokens: 700 }, { now: 210_000 }, { costUsd: 0.35 }])("wraps independently at %j", state => {
    const result = meetingBudgetSnapshot(limits, { startedAt: 0, now: 0, ...state });
    expect(result.wrapUp).toBe(true);
    expect(result.exhausted).toBe(false);
  });
  it.each([{ replies: 10 }, { tokens: 1000 }, { now: 300_000 }, { costUsd: 0.50 }])("stops independently at %j", state => {
    expect(meetingBudgetSnapshot(limits, { startedAt: 0, now: 0, ...state }).exhausted).toBe(true);
  });
  it("reserves finishing room using measured request duration, tokens and cost", () => {
    const result = meetingBudgetSnapshot(limits, { startedAt: 0, now: 100_000, tokens: 200, costUsd: 0.10,
      turnMilliseconds: 80_000, turnTokens: 300, turnCostUsd: 0.15 });
    expect(result.wrapUp).toBe(true);
    expect(result.exhausted).toBe(false);
    expect(result.time?.wrapUpSeconds).toBe(60);
    expect(result.tokens?.wrapUpAt).toBe(100);
    expect(result.cost?.wrapUpUsd).toBeCloseTo(0.05);
  });
  it("reports all remaining dimensions and leaves room to finish", () => {
    const text = meetingBudgetText(meetingBudgetSnapshot(limits, { startedAt: 0, now: 1000, replies: 6, tokens: 200, costUsd: 0.10 }));
    for (const value of ["4 of 10 replies", "800 of 1000 tokens", "299 seconds", "$0.400000", "Do not stop immediately"])
      expect(text).toContain(value);
  });
});
