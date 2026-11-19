import { describe, expect, it } from "vitest";
import { daysBetween, insightReadRange, summarizeInsights, validTimeZone } from "./usage-insights.ts";
import type { UsageRow } from "./usage-ledger.ts";

const row = (at: string, extra: Partial<UsageRow> = {}): UsageRow => ({
  at, botId: "b1", botName: "Writer", threadId: "t", instanceId: "claude", driverKind: "claudeAgent", model: "claude-sonnet-5-5",
  input: 1_000, output: 200, cachedInput: 400, costUsd: 0.5, trigger: { kind: "owner" }, ...extra,
});

describe("summarizeInsights", () => {
  it("buckets by the viewer's local day, zero-fills the period and compares it with the days before", () => {
    const rows = [
      row("2026-11-02T20:00:00Z"), // Nov 3 in Kolkata
      row("2026-11-03T03:00:00Z", { model: "gpt-5.5-codex", driverKind: "codex", costUsd: 0.25, outcome: { status: "error" } }),
      row("2026-10-31T10:00:00Z", { costUsd: 1 }),
      row("2026-10-20T10:00:00Z", { costUsd: 9 }),
    ];
    const insights = summarizeInsights(rows, { from: "2026-11-01", to: "2026-11-03" }, "Asia/Kolkata");
    expect(insights.unit).toBe("day");
    expect(insights.buckets.map((bucket) => [bucket.start, bucket.turns])).toEqual([["2026-11-01", 0], ["2026-11-02", 0], ["2026-11-03", 2]]);
    expect(insights.buckets[2]!.models).toEqual({ "model:claudeAgent/claude-sonnet-5-5": 800, "model:codex/gpt-5.5-codex": 800 });
    expect(insights.totals).toMatchObject({ turns: 2, costUsd: 0.75, input: 1_200, cachedInput: 800, output: 400, errors: 1, activeDays: 1, days: 3 });
    expect(insights.previous).toMatchObject({ turns: 1, costUsd: 1 });
    expect(insights.models.map((entry) => entry.key)).toEqual(["model:claudeAgent/claude-sonnet-5-5", "model:codex/gpt-5.5-codex"]);
    expect(insights.hours[2]![1]! + insights.hours[2]![8]!).toBe(2);
    expect(insights.routines.map((entry) => entry.key)).toEqual(["manual"]);
    expect(insights.departments.map((entry) => entry.key)).toEqual(["department:"]);
  });

  it("uses hours for a single day and never counts a turn with no price as free", () => {
    const insights = summarizeInsights([row("2026-11-03T14:10:00Z", { costUsd: null })], { from: "2026-11-03", to: "2026-11-03" }, "UTC");
    expect(insights.unit).toBe("hour");
    expect(insights.buckets).toHaveLength(24);
    expect(insights.buckets[14]).toMatchObject({ start: "2026-11-03T14", turns: 1 });
    expect(insights.totals).toMatchObject({ costUsd: null, unpriced: 1 });
  });
});

describe("insight helpers", () => {
  it("accepts only zones the runtime knows", () => {
    expect(validTimeZone("Europe/Berlin")).toBe("Europe/Berlin");
    expect(validTimeZone("Mars/Olympus")).toBeNull();
    expect(validTimeZone(null)).toBeNull();
  });

  it("reads one extra day either side and the whole period before", () => {
    expect(daysBetween("2026-02-27", "2026-03-01")).toEqual(["2026-02-27", "2026-02-28", "2026-03-01"]);
    const range = insightReadRange("2026-11-10", "2026-11-12");
    expect(range.from.toISOString()).toBe("2026-11-06T00:00:00.000Z");
    expect(range.to.toISOString()).toBe("2026-11-13T23:59:59.999Z");
  });
});
