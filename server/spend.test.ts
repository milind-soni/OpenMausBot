import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { billableFor, priceFor, type PriceList } from "./prices.ts";
import { assertWithinBudget, monthToDateSpend, noteSpend, resetSpendCacheForTests, spendState } from "./spend.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { appendUsage, flushUsageLedger } from "./usage-ledger.ts";

const yes = () => true;
const no = () => false;

describe("prices", () => {
  const prices: PriceList = {
    default: { inputPerMillion: 1, outputPerMillion: 2 },
    "claude-sonnet-5": { inputPerMillion: 3, outputPerMillion: 15, cachedInputPerMillion: 0.3 },
    "codex/gpt-5": { inputPerMillion: 2, outputPerMillion: 8 },
  };

  it("picks driver/model over model over default, and prices cached input apart when asked", () => {
    expect(priceFor({ driverKind: "codex", model: "gpt-5" }, prices)).toEqual({ inputPerMillion: 2, outputPerMillion: 8 });
    expect(priceFor({ driverKind: "claudeAgent", model: "claude-sonnet-5" }, prices)?.inputPerMillion).toBe(3);
    expect(priceFor({ driverKind: "x", model: "unknown" }, prices)?.inputPerMillion).toBe(1);
    expect(priceFor({ driverKind: "x", model: "unknown" }, { "claude-sonnet-5": prices["claude-sonnet-5"]! })).toBeNull();
    // 1M fresh input at 3, 1M cached at 0.3, 100k output at 15
    expect(billableFor({ driverKind: "claudeAgent", model: "claude-sonnet-5", input: 2_000_000, cachedInput: 1_000_000, output: 100_000 }, prices)).toBeCloseTo(3 + 0.3 + 1.5, 9);
    // cached input never exceeds input, and a missing price is null, not zero
    expect(billableFor({ driverKind: "codex", model: "gpt-5", input: 10, cachedInput: 50, output: 0 }, prices)).toBeCloseTo(10 * 2 / 1_000_000, 12);
    expect(billableFor({ driverKind: "x", model: "y", input: 10, output: 10 }, {})).toBeNull();
  });
});

describe("spend against a monthly cap", () => {
  let dataDir: string;
  const now = new Date("2026-09-15T12:00:00Z");
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), "omb-spend-")); resetSpendCacheForTests(); });
  afterEach(async () => { await removeTempDir(dataDir); });

  const row = (at: string, costUsd: number | null) => ({
    at, botId: "b", botName: "B", threadId: "t", instanceId: "claude", driverKind: "claudeAgent", model: "m",
    input: 10, output: 5, costUsd, trigger: { kind: "owner" as const },
  });

  it("sums only this month's reported costs, caches briefly, and takes a just-booked turn into account", async () => {
    appendUsage(dataDir, row("2026-08-31T23:59:00.000Z", 5));
    appendUsage(dataDir, row("2026-09-01T00:00:00.000Z", 0.4));
    appendUsage(dataDir, row("2026-09-10T00:00:00.000Z", null));
    appendUsage(dataDir, row("2026-09-14T00:00:00.000Z", 0.6));
    await flushUsageLedger(dataDir);
    expect(monthToDateSpend(dataDir, now)).toBeCloseTo(1.0, 9);
    appendUsage(dataDir, row("2026-09-15T11:00:00.000Z", 0.25));
    await flushUsageLedger(dataDir);
    // cached: the file is not re-read inside the window
    expect(monthToDateSpend(dataDir, now)).toBeCloseTo(1.0, 9);
    noteSpend(dataDir, 0.25, now);
    expect(monthToDateSpend(dataDir, now)).toBeCloseTo(1.25, 9);
    // a new month starts from zero
    expect(monthToDateSpend(dataDir, new Date("2026-10-01T00:00:01Z"))).toBe(0);
  });

  it("is inert without the entitlement or a cap, warns at the threshold, and refuses at the cap", async () => {
    appendUsage(dataDir, row("2026-09-02T00:00:00.000Z", 8));
    await flushUsageLedger(dataDir);
    expect(spendState({ budgets: { monthlyUsd: 10 } }, dataDir, now, no)).toBeNull();
    expect(spendState({}, dataDir, now, yes)).toBeNull();
    expect(spendState({ budgets: { monthlyUsd: 0 } }, dataDir, now, yes)).toBeNull();
    expect(spendState({ budgets: { monthlyUsd: 10 } }, dataDir, now, yes)).toEqual({
      month: "2026-09", monthlyUsd: 10, spentUsd: 8, percent: 80, warnAtPercent: 80, warn: true, exceeded: false,
    });
    expect(spendState({ budgets: { monthlyUsd: 10, warnAtPercent: 90 } }, dataDir, now, yes)?.warn).toBe(false);
    expect(() => assertWithinBudget({ budgets: { monthlyUsd: 10 } }, dataDir, now, yes)).not.toThrow();
    expect(() => assertWithinBudget({ budgets: { monthlyUsd: 8 } }, dataDir, now, yes)).toThrow(
      expect.objectContaining({ status: 409, code: "spend_cap", message: expect.stringContaining("$8.00") }),
    );
    expect(() => assertWithinBudget({ budgets: { monthlyUsd: 8 } }, dataDir, now, no)).not.toThrow();
  });
});
