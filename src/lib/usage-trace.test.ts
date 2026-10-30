import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TraceDetail, TraceTurn } from "../../shared/usage-trace";
import { formatDuration, groupLabel, timeAxis, toolLabel, traceBadges, traceRows, usagePeriodRange } from "./usage-trace";

vi.mock("@/state/store", async (original) => {
  const actual = await original<typeof import("@/state/store")>();
  return { ...actual, useStore: () => ({ state: actual.initialState, dispatch: vi.fn() }), api: vi.fn(() => new Promise(() => {})) };
});
const { TraceWaterfall } = await import("../components/usage/TraceWaterfall");
const { usageGroupLabel } = await import("../components/UsageSection");

const T0 = Date.UTC(2026, 9, 22, 9, 0, 0);
const turn = (id: string, botName: string, start: number, end: number | undefined, children: TraceTurn["children"], extra: Partial<TraceTurn> = {}): TraceTurn => ({
  kind: "turn", id, threadId: id, turnId: "t", botId: id, botName, model: "claude-sonnet-5-5", driverKind: "claude",
  startedAt: T0 + start, ...(end === undefined ? { running: true } : { endedAt: T0 + end }), timed: true, status: "ok",
  costUsd: 0.05, tokens: { input: 1_000, cachedInput: 600, output: 200 }, usageStatus: "complete", children, ...extra,
});
const writer = turn("writer", "Writer", 2_000, 37_000, [
  { kind: "step", id: "w-s1", startedAt: T0 + 2_500, endedAt: T0 + 25_500, costUsd: 0.09, tokens: { input: 900, cachedInput: 500, output: 700 } },
  { kind: "tool", id: "w-t1", name: "mcp__composio__NOTION_CREATE_PAGE", icon: "app", app: "notion", detail: "Pricing draft", startedAt: T0 + 26_000, endedAt: T0 + 29_600, status: "ok", timedBy: "omb" },
  { kind: "tool", id: "w-t2", name: "WebSearch", icon: "search", detail: "G2 reviews", startedAt: T0 + 30_000, endedAt: T0 + 31_000, status: "error", error: "Rate limited", timedBy: "engine" },
  { kind: "group", id: "w-g1", icon: "browser", name: "mcp__browser__agent_browser_click", count: 3, errors: 0, startedAt: T0 + 31_500, endedAt: T0 + 36_000, children: [
    { kind: "tool", id: "w-b1", name: "mcp__browser__agent_browser_open", icon: "browser", startedAt: T0 + 31_500, endedAt: T0 + 32_000, status: "ok", timedBy: "omb" },
    { kind: "tool", id: "w-b2", name: "mcp__browser__agent_browser_click", icon: "browser", startedAt: T0 + 33_000, endedAt: T0 + 33_500, status: "ok", timedBy: "omb" },
    { kind: "tool", id: "w-b3", name: "mcp__browser__agent_browser_type", icon: "browser", startedAt: T0 + 35_000, endedAt: T0 + 36_000, status: "ok", timedBy: "omb" },
  ] },
]);
const chief = turn("chief", "Chief", 0, undefined, [
  { kind: "step", id: "c-s1", startedAt: T0, endedAt: T0 + 6_900, costUsd: 0.12, tokens: { input: 4_000, cachedInput: 3_000, output: 300 } },
  writer,
]);
const detail: TraceDetail = {
  root: {
    id: "chief~t", title: "Launch the new pricing page by Friday", source: "person", startedAt: T0, endedAt: T0 + 51_000, running: true, timed: true,
    bots: [{ id: "chief", name: "Chief" }, { id: "writer", name: "Writer" }], usageStatus: "complete",
    durationMs: 51_000, costUsd: 0.42, tokens: 85_200, input: 80_000, cachedInput: 60_000, output: 5_200, steps: 4, tools: 10, errors: 1,
  },
  turns: [chief],
};

describe("trace helpers", () => {
  it("formats durations the way the waterfall labels them", () => {
    expect([450, 6_900, 51_000, 100_000, 3_600_000, 7_500_000].map(formatDuration)).toEqual(["450ms", "6.9s", "51s", "1m 40s", "1h", "2h 5m"]);
    expect(timeAxis(51_000)).toEqual({ max: 60_000, ticks: [0, 20_000, 40_000, 60_000] });
    expect(timeAxis(400).ticks.length).toBeGreaterThanOrEqual(2);
  });

  it("opens turns and keeps groups shut until toggled, and names each browser step by its action", () => {
    const rows = traceRows([chief], new Set(), T0 + 51_000);
    expect(rows.map((row) => [row.node.id, row.depth])).toEqual([["chief", 0], ["c-s1", 1], ["writer", 1], ["w-s1", 2], ["w-t1", 2], ["w-t2", 2], ["w-g1", 2]]);
    expect(rows[0]).toMatchObject({ durationMs: 51_000, costUsd: 0.1 });
    const opened = traceRows([chief], new Set(["w-g1", "writer"]), T0 + 51_000);
    expect(opened.map((row) => row.node.id)).toEqual(["chief", "c-s1", "writer"]);
    expect(traceRows([chief], new Set(["w-g1"]), T0).map((row) => row.node.id)).toContain("w-b3");
    expect(toolLabel({ name: "mcp__browser__agent_browser_type", icon: "browser" })).toBe("Type");
    expect(groupLabel({ icon: "browser", count: 14, name: "x" })).toBe("Used the browser · 14 steps");
    expect(groupLabel({ icon: "computer", count: 23, name: "x" })).toBe("Used the computer · 23 actions");
  });

  it("marks the slowest step or tool and the most expensive span", () => {
    expect(traceBadges([chief], T0 + 51_000)).toEqual({ slowest: "w-s1", costliest: "c-s1" });
  });

  it("names the groupings that are not a person in plain words", () => {
    expect(usageGroupLabel("user", { key: "owner", label: "This computer" })).toBe("This computer");
    expect(usageGroupLabel("user", { key: "bot", label: "Bot to bot" })).toBe("Bot to bot");
    expect(usageGroupLabel("user", { key: "routine:r1", label: "Routine: Morning digest" })).toBe("Routine: Morning digest");
    expect(usageGroupLabel("user", { key: "user:ada@example.test", label: "ada@example.test" })).toBe("ada@example.test");
    expect(usageGroupLabel("routine", { key: "manual", label: "Not from a routine" })).toBe("Not from a routine");
  });

  it("picks calendar periods in UTC days", () => {
    const now = new Date(Date.UTC(2026, 9, 22, 15));
    expect(usagePeriodRange("today", now)).toEqual({ from: "2026-10-22", to: "2026-10-22" });
    expect(usagePeriodRange("week", now)).toEqual({ from: "2026-10-16", to: "2026-10-22" });
    expect(usagePeriodRange("lastMonth", now)).toEqual({ from: "2026-09-01", to: "2026-09-30" });
  });

  it("draws the waterfall with its stat strip, Live badge, time and cost labels, badges and a red error", () => {
    const html = renderToStaticMarkup(createElement(TraceWaterfall, { detail, now: T0 + 51_000 }));
    for (const text of ["Launch the new pricing page by Friday", "Duration", "51s", "$0.42", "85.2k", "AI steps", "Tool uses", "Live",
      "Chief", "Writer", "AI step", "Search the web", "Rate limited", "Used the browser · 3 steps",
      "6.9s · $0.12", "23s · $0.09", "Slowest", "Most expensive", "0s", "20s", "40s", "1m"]) expect(html).toContain(text);
    expect(html).toMatch(/text-danger[^>]*>Search the web/);
    expect(html).toContain("trace-bar-error");
    expect(html.match(/role="treeitem"/g)).toHaveLength(7);
  });
});
