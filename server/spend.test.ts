import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { billableFor, priceFor, type PriceList } from "./prices.ts";
import { assertWithinBudget, monthToDateSpend, noteSpend, resetSpendAlertsForTests, resetSpendCacheForTests, spendAlertText, spendState, takeSpendAlert, type SpendState } from "./spend.ts";
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
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), "omb-spend-")); resetSpendCacheForTests(); resetSpendAlertsForTests(); });
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
    // written behind the cache's back: the file is not re-read inside the window
    appendUsage(dataDir, row("2026-09-15T11:00:00.000Z", 0.25));
    await flushUsageLedger(dataDir);
    expect(monthToDateSpend(dataDir, now)).toBeCloseTo(1.0, 9);
    // booked through noteSpend: counted at once, and once
    const booked = row("2026-09-15T11:30:00.000Z", 0.25);
    noteSpend(dataDir, booked, appendUsage(dataDir, booked));
    expect(monthToDateSpend(dataDir, now)).toBeCloseTo(1.25, 9);
    await flushUsageLedger(dataDir);
    await Promise.resolve();
    expect(monthToDateSpend(dataDir, now)).toBeCloseTo(1.25, 9);
    // a new month starts from zero
    expect(monthToDateSpend(dataDir, new Date("2026-10-01T00:00:01Z"))).toBe(0);
  });

  it("counts a turn longer than the cache window the moment it is booked, before its row lands", async () => {
    const cfg = { budgets: { monthlyUsd: 1, warnAtPercent: 80 } };
    const start = new Date("2026-09-15T12:00:00Z");
    // the turn starts: its admission check fills the cache with an empty month
    expect(spendState(cfg, dataDir, start, yes)).toMatchObject({ spentUsd: 0, exceeded: false });
    // it settles 60 s later, $1.20 against a $1 cap; the append is still in flight
    const end = new Date(start.getTime() + 60_000);
    const booked = row(end.toISOString(), 1.2);
    const written = appendUsage(dataDir, booked);
    noteSpend(dataDir, booked, written);
    const crossed = spendState(cfg, dataDir, end, yes);
    expect(crossed).toMatchObject({ spentUsd: 1.2, exceeded: true, warn: true });
    // so the turn that crossed the line raises the notice...
    expect(takeSpendAlert(dataDir, crossed)).toBe("cap");
    // ...and the next turn is refused, not let through on a stale read
    expect(() => assertWithinBudget(cfg, dataDir, new Date(end.getTime() + 1_000), yes)).toThrow(expect.objectContaining({ code: "spend_cap" }));
    // once the row lands it counts once: from the cached read, and from a fresh one
    expect(await written).toBe(true);
    await Promise.resolve();
    expect(monthToDateSpend(dataDir, new Date(end.getTime() + 2_000))).toBeCloseTo(1.2, 9);
    expect(monthToDateSpend(dataDir, new Date(end.getTime() + 60_000))).toBeCloseTo(1.2, 9);
  });

  it("never counts a booked turn twice when a re-read already sees its row, and drops one whose write failed", async () => {
    const onDisk = row("2026-09-15T11:00:00.000Z", 0.5);
    await appendUsage(dataDir, onDisk);
    // the write landed but its promise has not been observed yet
    noteSpend(dataDir, onDisk, new Promise<boolean>(() => {}));
    expect(monthToDateSpend(dataDir, now)).toBeCloseTo(0.5, 9);
    const lost = row("2026-09-15T11:05:00.000Z", 0.3);
    noteSpend(dataDir, lost, Promise.resolve(false));
    expect(monthToDateSpend(dataDir, now)).toBeCloseTo(0.8, 9);
    await Promise.resolve();
    await Promise.resolve();
    expect(monthToDateSpend(dataDir, now)).toBeCloseTo(0.5, 9);
    // an unpriced turn books nothing
    noteSpend(dataDir, row("2026-09-15T11:06:00.000Z", null), new Promise<boolean>(() => {}));
    expect(monthToDateSpend(dataDir, now)).toBeCloseTo(0.5, 9);
  });

  it("counts estimated costs against the cap exactly like reported ones", async () => {
    appendUsage(dataDir, row("2026-09-02T00:00:00.000Z", 3));
    appendUsage(dataDir, { ...row("2026-09-03T00:00:00.000Z", 6), driverKind: "codex", model: "gpt-5.5", costSource: "estimated" });
    await flushUsageLedger(dataDir);
    expect(spendState({ budgets: { monthlyUsd: 10 } }, dataDir, now, yes)).toMatchObject({ spentUsd: 9, percent: 90, warn: true, exceeded: false });
    expect(() => assertWithinBudget({ budgets: { monthlyUsd: 9 } }, dataDir, now, yes)).toThrow(expect.objectContaining({ code: "spend_cap" }));
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

describe("spend notices", () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), "omb-spend-alerts-")); resetSpendAlertsForTests(); });
  afterEach(async () => { await removeTempDir(dataDir); });

  const state = (over: Partial<SpendState>): SpendState => ({
    month: "2026-09", monthlyUsd: 100, spentUsd: 50, percent: 50, warnAtPercent: 80, warn: false, exceeded: false, ...over,
  });

  it("warns once when the month crosses the threshold, and once more when it reaches the cap", () => {
    expect(takeSpendAlert(dataDir, null)).toBeNull();
    expect(takeSpendAlert(dataDir, state({}))).toBeNull();
    expect(takeSpendAlert(dataDir, state({ spentUsd: 81, percent: 81, warn: true }))).toBe("warn");
    expect(takeSpendAlert(dataDir, state({ spentUsd: 85, percent: 85, warn: true }))).toBeNull();
    expect(takeSpendAlert(dataDir, state({ spentUsd: 100, percent: 100, warn: true, exceeded: true }))).toBe("cap");
    expect(takeSpendAlert(dataDir, state({ spentUsd: 120, percent: 120, warn: true, exceeded: true }))).toBeNull();
  });

  it("sends only the cap notice when one turn jumps straight past both lines", () => {
    expect(takeSpendAlert(dataDir, state({ spentUsd: 130, percent: 130, warn: true, exceeded: true }))).toBe("cap");
    expect(takeSpendAlert(dataDir, state({ spentUsd: 131, percent: 131, warn: true, exceeded: true }))).toBeNull();
  });

  it("remembers across a restart, and starts over for a new month or a new cap", () => {
    expect(takeSpendAlert(dataDir, state({ warn: true, percent: 90 }))).toBe("warn");
    resetSpendAlertsForTests(); // a restart: only the file remains
    expect(takeSpendAlert(dataDir, state({ warn: true, percent: 91 }))).toBeNull();
    expect(takeSpendAlert(dataDir, state({ month: "2026-10", warn: true, percent: 90 }))).toBe("warn");
    expect(takeSpendAlert(dataDir, state({ month: "2026-10", monthlyUsd: 200, spentUsd: 170, warn: true, percent: 85 }))).toBe("warn");
  });

  it("still notifies once per run when the marks cannot be written", () => {
    rmSync(dataDir, { recursive: true, force: true });
    writeFileSync(dataDir, "a file where the data directory should be");
    expect(takeSpendAlert(dataDir, state({ warn: true, percent: 90 }))).toBe("warn");
    expect(takeSpendAlert(dataDir, state({ warn: true, percent: 95 }))).toBeNull();
    rmSync(dataDir, { force: true });
  });

  it("words the notice plainly", () => {
    expect(spendAlertText("warn", state({ spentUsd: 81.5, percent: 81, warn: true }))).toEqual({
      title: "Spend is at 81% of the monthly limit",
      body: "$81.50 of $100.00 spent this month (2026-09). New turns stop when the limit is reached.",
    });
    expect(spendAlertText("cap", state({ spentUsd: 100.004, percent: 100, exceeded: true })).body)
      .toBe("$100.00 of $100.00 spent this month (2026-09). New turns are refused until an admin raises the limit under Settings → Usage.");
  });
});
