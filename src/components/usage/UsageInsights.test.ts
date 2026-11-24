// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/state/store", () => ({
  api: {},
  useStore: () => ({ state: { bots: [], instances: [] } }),
}));

import type { InsightEntry, InsightTotals, UsageInsights } from "../../../shared/usage-insights";
import { Breakdown, Overview, Shares } from "./UsageInsights";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

const totals = (over: Partial<InsightTotals> = {}): InsightTotals => ({
  input: 1_000,
  cachedInput: 0,
  output: 500,
  reasoning: 0,
  turns: 4,
  costUsd: 0,
  unpriced: 0,
  errors: 0,
  tools: 0,
  durationMs: 0,
  timedTurns: 0,
  activeDays: 1,
  days: 30,
  ...over,
});

const modelEntry = (over: Partial<InsightEntry> = {}): InsightEntry => ({
  key: "model:claudeAgent/claude-sonnet-5-5",
  label: "claude-sonnet-5-5",
  input: 1_000,
  cachedInput: 0,
  output: 500,
  reasoning: 0,
  turns: 4,
  costUsd: 0,
  errors: 0,
  durationMs: 0,
  timedTurns: 0,
  ...over,
});

const personEntry = (over: Partial<InsightEntry> = {}): InsightEntry => ({
  key: "user:alice",
  label: "Alice",
  input: 1_000,
  cachedInput: 0,
  output: 500,
  reasoning: 0,
  turns: 4,
  costUsd: 0,
  errors: 0,
  durationMs: 0,
  timedTurns: 0,
  ...over,
});

const baseInsights = (
  models: InsightEntry[],
  totalOver: Partial<InsightTotals>,
  previousOver: Partial<InsightTotals> = {},
  people: InsightEntry[] = [],
): UsageInsights => ({
  from: "2026-11-01",
  to: "2026-11-30",
  timeZone: "UTC",
  totals: totals(totalOver),
  previous: totals({ costUsd: null, turns: 0, ...previousOver }),
  unit: "day",
  buckets: [{
    start: "2026-11-01",
    input: 1_000,
    cachedInput: 0,
    output: 500,
    reasoning: 0,
    turns: 4,
    costUsd: totalOver.costUsd ?? 0,
    billedCostUsd: totalOver.billedCostUsd ?? (totalOver.costUsd ?? 0),
    planCostUsd: totalOver.planCostUsd ?? 0,
    unpriced: 0,
    errors: 0,
    durationMs: 0,
    timedTurns: 0,
    models: { [models[0]!.key]: 1_500 },
    modelCosts: { [models[0]!.key]: totalOver.costUsd ?? 0 },
  }],
  hours: Array.from({ length: 7 }, () => Array<number>(24).fill(0)),
  models,
  bots: [],
  engines: [],
  people,
  routines: [],
  departments: [],
});

const labelOf = (_kind: "bot" | "user" | "routine" | "department", entry: Pick<InsightEntry, "key" | "label">) => entry.label;

const renderOverview = (data: UsageInsights, metric: "cost" | "tokens" = "cost") => flushSync(() => {
  root.render(createElement(Overview, { data, metric }));
});

const renderShares = (data: UsageInsights, metric: "cost" | "tokens" = "cost") => flushSync(() => {
  root.render(createElement(Shares, { data, metric, groupLabel: labelOf }));
});

const renderBreakdown = (data: UsageInsights, metric: "cost" | "tokens" = "cost") => flushSync(() => {
  root.render(createElement(Breakdown, { data, metric, groupLabel: labelOf }));
});

describe("Spending Overview plan vs billed separation", () => {
  it("headlines $0.00 billed and labels subscription usage as estimated plan value", () => {
    const data = baseInsights(
      [modelEntry({ costUsd: 2.78, billedCostUsd: 0, planCostUsd: 2.78 })],
      { costUsd: 2.78, billedCostUsd: 0, planCostUsd: 2.78 },
    );
    renderOverview(data, "cost");
    const hero = host.querySelector('[data-testid="insight-hero"]')!;
    expect(hero.querySelectorAll("span")[1]?.textContent).toBe("$0");
    expect(hero.textContent).toContain("$2.78 estimated value on your plans");
    const list = host.querySelector('[aria-label="Providers"]')!;
    expect(list.textContent).toContain("Anthropic");
    expect(list.textContent).toContain("On plan");
    expect(list.textContent).toContain("On plan · not billed");
    expect(list.textContent).toContain("$2.78");
    expect(list.textContent).not.toContain("100% of spend");
    expect(host.textContent).toContain("Includes estimated plan value");
    const note = [...host.querySelectorAll("span")].find((el) => el.textContent === "Includes estimated plan value");
    expect(note?.className).toContain("text-[12px]");
    expect(note?.className).not.toContain("text-[11px]");
  });

  it("computes spend shares out of billed spend when metered and plan usage coexist", () => {
    const data = baseInsights(
      [
        modelEntry({ key: "model:codex/gpt-5.5", label: "gpt-5.5", costUsd: 1, billedCostUsd: 1, planCostUsd: 0 }),
        modelEntry({ key: "model:claudeAgent/claude-sonnet-5-5", costUsd: 5, billedCostUsd: 2, planCostUsd: 3 }),
      ],
      { costUsd: 6, billedCostUsd: 3, planCostUsd: 3 },
    );
    renderOverview(data, "cost");
    const hero = host.querySelector('[data-testid="insight-hero"]')!;
    expect(hero.textContent).toContain("$3.00");
    expect(hero.textContent).toContain("$3.00 estimated value on your plans");
    const items = [...host.querySelectorAll('[aria-label="Providers"] li')].map((li) => li.textContent ?? "");
    expect(items[0]).toContain("Anthropic");
    expect(items[0]).toContain("$2.00");
    expect(items[0]).toContain("67% of spend");
    expect(items[0]).toContain("$3.00 on plan");
    expect(items[1]).toContain("OpenAI");
    expect(items[1]).toContain("$1.00");
    expect(items[1]).toContain("33% of spend");
    expect(host.textContent).toContain("Includes estimated plan value");
  });

  it("keeps pure billed and token views free of plan annotations", () => {
    const pureBilled = baseInsights(
      [modelEntry({ costUsd: 2.5, billedCostUsd: 2.5, planCostUsd: 0 })],
      { costUsd: 2.5, billedCostUsd: 2.5, planCostUsd: 0 },
    );
    renderOverview(pureBilled, "cost");
    expect(host.textContent).toContain("$2.50");
    expect(host.textContent).not.toContain("estimated value on your plans");
    expect(host.textContent).not.toContain("On plan");
    expect(host.textContent).not.toContain("Includes estimated plan value");

    const withPlan = baseInsights(
      [modelEntry({ costUsd: 2.78, billedCostUsd: 0, planCostUsd: 2.78, input: 1_200, output: 300 })],
      { costUsd: 2.78, billedCostUsd: 0, planCostUsd: 2.78, input: 1_200, output: 300 },
    );
    renderOverview(withPlan, "tokens");
    expect(host.textContent).not.toContain("estimated value on your plans");
    expect(host.textContent).not.toContain("Includes estimated plan value");
    expect(host.textContent).toContain("100% of tokens");
  });

  it("excludes plan-only usage from Shares spend by person while preserving billed shares and plan note", () => {
    const purePlan = baseInsights(
      [modelEntry({ costUsd: 2.78, billedCostUsd: 0, planCostUsd: 2.78 })],
      { costUsd: 2.78, billedCostUsd: 0, planCostUsd: 2.78 },
      {},
      [personEntry({ costUsd: 2.78, billedCostUsd: 0, planCostUsd: 2.78 })],
    );
    renderShares(purePlan, "cost");
    expect(host.textContent).toContain("$2.78 estimated value on your plans");
    expect(host.textContent).not.toContain("100%");

    const mixed = baseInsights(
      [modelEntry({ costUsd: 6, billedCostUsd: 3, planCostUsd: 3 })],
      { costUsd: 6, billedCostUsd: 3, planCostUsd: 3 },
      {},
      [
        personEntry({ key: "user:alice", label: "Alice", costUsd: 5, billedCostUsd: 2, planCostUsd: 3 }),
        personEntry({ key: "user:bob", label: "Bob", costUsd: 1, billedCostUsd: 1, planCostUsd: 0 }),
      ],
    );
    renderShares(mixed, "cost");
    expect(host.textContent).toContain("$3.00 estimated value on your plans");
    expect(host.textContent).toContain("Alice");
    expect(host.textContent).toContain("$2.00");
    expect(host.textContent).toContain("67%");
    expect(host.textContent).toContain("Bob");
    expect(host.textContent).toContain("$1.00");
    expect(host.textContent).toContain("33%");

    renderShares(purePlan, "tokens");
    expect(host.textContent).not.toContain("estimated value on your plans");
  });

  it("separates billed spend from plan estimates in Breakdown across model rows and time buckets", () => {
    const purePlan = baseInsights(
      [modelEntry({ costUsd: 2.78, billedCostUsd: 0, planCostUsd: 2.78 })],
      { costUsd: 2.78, billedCostUsd: 0, planCostUsd: 2.78 },
    );
    renderBreakdown(purePlan, "cost");
    expect(host.textContent).toContain("$0");
    expect(host.textContent).toContain("$2.78 on plan");
    expect(host.textContent).not.toContain("100%");

    const mixed = baseInsights(
      [
        modelEntry({ key: "model:codex/gpt-5.5", label: "gpt-5.5", costUsd: 1, billedCostUsd: 1, planCostUsd: 0 }),
        modelEntry({ key: "model:claudeAgent/claude-sonnet-5-5", costUsd: 5, billedCostUsd: 2, planCostUsd: 3 }),
      ],
      { costUsd: 6, billedCostUsd: 3, planCostUsd: 3 },
    );
    renderBreakdown(mixed, "cost");
    const rows = [...host.querySelectorAll('[data-testid="insight-breakdown"] [role="row"]')].slice(1).map((row) => row.textContent ?? "");
    expect(rows[0]).toContain("claude-sonnet-5-5");
    expect(rows[0]).toContain("$2.00");
    expect(rows[0]).toContain("$3.00 on plan");
    expect(rows[0]).toContain("67%");
    expect(rows[1]).toContain("gpt-5.5");
    expect(rows[1]).toContain("$1.00");
    expect(rows[1]).toContain("33%");

    const pureBilled = baseInsights(
      [modelEntry({ costUsd: 2.5, billedCostUsd: 2.5, planCostUsd: 0 })],
      { costUsd: 2.5, billedCostUsd: 2.5, planCostUsd: 0 },
    );
    renderBreakdown(pureBilled, "cost");
    expect(host.textContent).toContain("$2.50");
    expect(host.textContent).not.toContain("on plan");

    renderBreakdown(purePlan, "cost");
    const select = host.querySelector("select")!;
    flushSync(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      setter?.call(select, "time");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(host.textContent).toContain("$0");
    expect(host.textContent).toContain("$2.78 on plan");

    renderBreakdown(purePlan, "tokens");
    expect(host.textContent).toContain("$2.78");
    expect(host.textContent).not.toContain("on plan");

    const tokensSelect = host.querySelector("select")!;
    flushSync(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      setter?.call(tokensSelect, "time");
      tokensSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(host.textContent).toContain("$2.78");
    expect(host.textContent).not.toContain("on plan");
  });
});
