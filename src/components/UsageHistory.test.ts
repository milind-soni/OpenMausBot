import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UsageHistoryTable, usageExportHref, usageGroupLabel, usagePeriodRange, type UsageSummary } from "./UsageHistory";

const group = (key: string, label: string, over: Partial<UsageSummary["groups"][number]> = {}) => ({
  key, label, turns: 3, input: 12_000, output: 2_000, cachedInput: 9_000, costUsd: 0.42, unpriced: 0, ...over,
});

describe("usage history table", () => {
  it("renders groups with localized names for the non-person triggers and flags unpriced turns", () => {
    const summary: UsageSummary = {
      from: "2026-09-01T00:00:00.000Z", to: "2026-09-30T23:59:59.999Z", groupBy: "user",
      groups: [
        group("user:ada@example.test", "ada@example.test"),
        group("owner", "This computer"),
        group("routine:r1", "Routine: Morning digest"),
        group("bot", "Bot to bot", { costUsd: null, unpriced: 3 }),
      ],
      total: group("total", "total", { turns: 12, costUsd: 1.26, unpriced: 3 }),
    };
    const html = renderToStaticMarkup(createElement(UsageHistoryTable, { summary }));
    expect(html).toContain("ada@example.test");
    expect(html).toContain("This computer");
    expect(html).toContain("Routine: Morning digest");
    expect(html).toContain("Bot to bot");
    expect(html).toContain("Person");
    expect(html).toContain("3 turn(s) came from engines that report no price");
    expect(html).toContain("$1.26");
  });

  it("says so when the period is empty", () => {
    const summary: UsageSummary = { from: "", to: "", groupBy: "bot", groups: [], total: group("total", "total", { turns: 0, costUsd: null }) };
    expect(renderToStaticMarkup(createElement(UsageHistoryTable, { summary }))).toContain("Nothing recorded in this period.");
  });
});

describe("usage history helpers", () => {
  it("computes inclusive UTC day bounds for each preset", () => {
    const now = new Date("2026-09-15T12:00:00Z");
    expect(usagePeriodRange("month", now)).toEqual({ from: "2026-09-01", to: "2026-09-15" });
    expect(usagePeriodRange("lastMonth", now)).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    expect(usagePeriodRange("days30", now)).toEqual({ from: "2026-08-17", to: "2026-09-15" });
    expect(usagePeriodRange("lastMonth", new Date("2026-01-10T00:00:00Z"))).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });

  it("labels people by the server's text and everything else by key", () => {
    expect(usageGroupLabel("user", group("user:x@y.test", "x@y.test"))).toBe("x@y.test");
    expect(usageGroupLabel("user", group("owner", "This computer"))).toBe("This computer");
    expect(usageGroupLabel("user", group("routine:r9", "Routine: Weekly"))).toBe("Routine: Weekly");
    expect(usageGroupLabel("bot", group("bot:b1", "Scout"))).toBe("Scout");
    expect(usageExportHref({ from: "2026-09-01", to: "2026-09-30" })).toBe("/api/usage.csv?from=2026-09-01&to=2026-09-30");
  });
});
