// Context budget (Phase 1 part 1): how big a model's window is, how much of
// it a thread may carry before the harness compacts, and whether the last
// turn crossed that line — from the input tokens the engine reported, or an
// estimate when it reported none.
import { afterEach, describe, expect, it } from "vitest";

import { compactBudget, contextWindowFor, estimateTokens, shouldCompact } from "./context-budget.ts";

describe("contextWindowFor", () => {
  afterEach(() => { delete process.env.OMB_CONTEXT_WINDOW; });

  it("prefers the catalog, then a pattern over the model id, then a default", () => {
    const catalog = { default: "m", options: [{ id: "m", label: "m", contextWindow: 64_000 }] };
    expect(contextWindowFor("m", catalog)).toEqual({ contextWindow: 64_000, source: "catalog" });
    expect(contextWindowFor("claude-sonnet-5")).toEqual({ contextWindow: 200_000, source: "pattern" });
    expect(contextWindowFor("gpt-5.6-sol")).toEqual({ contextWindow: 272_000, source: "pattern" });
    expect(contextWindowFor("claude-sonnet-5", undefined, 250_000)).toEqual({ contextWindow: 250_000, source: "reported" });
    expect(contextWindowFor("mystery-model")).toEqual({ contextWindow: 128_000, source: "default" });
    expect(contextWindowFor(undefined)).toEqual({ contextWindow: 128_000, source: "default" });
  });

  it("can be forced for tests", () => {
    process.env.OMB_CONTEXT_WINDOW = "100000";
    expect(contextWindowFor("claude-sonnet-5")).toEqual({ contextWindow: 100_000, source: "forced" });
  });
});

describe("compactBudget", () => {
  it("stays below an engine that compacts its own session, so our record is written first", () => {
    // A Sonnet-class window puts the 0.8 share at 800k — far above the CLI's
    // own 200k backstop. The CLI would compact first, no harness record would
    // ever be written, and the thread's history would live only inside that
    // session: gone the moment it moves to another model.
    expect(compactBudget(undefined, 1_000_000, 200_000)).toBe(180_000);
    expect(compactBudget(undefined, 400_000, 200_000)).toBe(180_000);
    // below the backstop already: the share stands
    expect(compactBudget(undefined, 200_000, 200_000)).toBe(160_000);
    // no engine-side compaction: nothing to stay under
    expect(compactBudget(undefined, 1_000_000)).toBe(800_000);
  });

  it("is a share of the window below 1, an absolute count otherwise, never under the floor", () => {
    expect(compactBudget(undefined, 200_000)).toBe(160_000);
    expect(compactBudget(0.5, 200_000)).toBe(100_000);
    expect(compactBudget(50_000, 200_000)).toBe(50_000);
    expect(compactBudget(0.6, 10_000)).toBe(8_000);
  });
});

describe("shouldCompact", () => {
  it("trusts the window reading, then the last turn's input, then the estimate", () => {
    expect(shouldCompact({ contextTokens: 130_000, lastTurnInput: 260_000, estimatedTokens: 0, budget: 120_000 })).toBe(true);
    // a tool-using turn sums two model calls: its input can be twice the window fill
    expect(shouldCompact({ contextTokens: 64_000, lastTurnInput: 127_000, estimatedTokens: 0, budget: 120_000 })).toBe(false);
    expect(shouldCompact({ lastTurnInput: 130_000, estimatedTokens: 0, budget: 120_000 })).toBe(true);
    expect(shouldCompact({ estimatedTokens: 130_000, budget: 120_000 })).toBe(true);
    expect(shouldCompact({ contextTokens: 0, lastTurnInput: 0, estimatedTokens: 100, budget: 120_000 })).toBe(false);
  });

  it("does not compact again until the context has regrown a quarter past the floor left by the last compaction", () => {
    // budget 60k, but the system prompt plus the kept exchanges cost 90k: over budget forever
    expect(shouldCompact({ contextTokens: 91_000, estimatedTokens: 0, budget: 60_000, floor: 90_000 })).toBe(false);
    expect(shouldCompact({ contextTokens: 112_000, estimatedTokens: 0, budget: 60_000, floor: 90_000 })).toBe(false);
    expect(shouldCompact({ contextTokens: 113_000, estimatedTokens: 0, budget: 60_000, floor: 90_000 })).toBe(true);
  });
});

describe("estimateTokens", () => {
  it("is bytes over four, rounded up", () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(9)).toBe(3);
  });
});
