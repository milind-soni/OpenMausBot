// The headless bench driver (Phase 0, item 0.8): one detached thread on one
// bot, a budget in steps/tokens/minutes, and a result + trajectory anyone
// can read. These are the pure parts: budget parsing, the exceeded check,
// and the result record.
import { describe, expect, it } from "vitest";

import { benchResult, budgetExceeded, parseBudget, type BenchRun } from "./bench.ts";

const run = (over: Partial<BenchRun> = {}): BenchRun => ({
  id: "b1",
  botId: "bot",
  botName: "Dev",
  threadId: "t1",
  task: "do the thing",
  budget: { steps: 10, tokens: 1_000, minutes: 5 },
  startedAt: 1_000,
  status: "running",
  steps: 0,
  turns: 0,
  tokens: { input: 0, output: 0, cachedInput: 0 },
  costUsd: null,
  driverKind: "claudeAgent",
  model: "m",
  ...over,
});

describe("parseBudget", () => {
  it("reads steps, tokens and minutes from the CLI form and from an object, with defaults for what is missing", () => {
    expect(parseBudget("steps=200,tokens=400000,minutes=30")).toEqual({ steps: 200, tokens: 400_000, minutes: 30 });
    expect(parseBudget({ minutes: 0.5 })).toEqual({ steps: 200, tokens: 400_000, minutes: 0.5 });
    expect(parseBudget(undefined)).toEqual({ steps: 200, tokens: 400_000, minutes: 30 });
  });

  it("rejects unknown keys and non-positive numbers", () => {
    expect(() => parseBudget("steps=0")).toThrow(/steps/);
    expect(() => parseBudget("hours=1")).toThrow(/hours/);
    expect(() => parseBudget({ tokens: "many" })).toThrow(/tokens/);
  });
});

describe("budgetExceeded", () => {
  it("names the first budget a run has crossed, or null", () => {
    expect(budgetExceeded(run(), 2_000)).toBeNull();
    expect(budgetExceeded(run({ steps: 10 }), 2_000)).toBe("steps");
    expect(budgetExceeded(run({ tokens: { input: 900, output: 100, cachedInput: 0 } }), 2_000)).toBe("tokens");
    expect(budgetExceeded(run(), 1_000 + 5 * 60_000)).toBe("minutes");
  });
});

describe("benchResult", () => {
  it("is the result.json shape: status, budgets, what was spent, and the engine it ran on", () => {
    const record = run({ status: "settled", endedAt: 61_000, steps: 3, turns: 1, tokens: { input: 40, output: 8, cachedInput: 2 }, costUsd: 0.01, network: { allow: ["example.com"] } });
    expect(benchResult(record)).toEqual({
      id: "b1",
      status: "settled",
      botId: "bot",
      botName: "Dev",
      threadId: "t1",
      driverKind: "claudeAgent",
      model: "m",
      budget: { steps: 10, tokens: 1_000, minutes: 5 },
      network: { allow: ["example.com"], enforced: false },
      steps: 3,
      turns: 1,
      tokens: { input: 40, output: 8, cachedInput: 2 },
      costUsd: 0.01,
      durationMs: 60_000,
    });
    expect(benchResult(run({ status: "budget_exceeded", exceeded: "steps", endedAt: 2_000 }))).toMatchObject({ status: "budget_exceeded", exceeded: "steps", durationMs: 1_000 });
  });
});
