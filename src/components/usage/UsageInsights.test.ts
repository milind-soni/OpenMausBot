// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { InsightEntry, InsightTotals, UsageInsights } from "../../../shared/usage-insights";
import { Overview } from "./UsageInsights";

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

const baseInsights = (models: InsightEntry[], totalOver: Partial<InsightTotals>, previousOver: Partial<InsightTotals> = {}): UsageInsights => ({
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
  people: [],
  routines: [],
  departments: [],
});

const renderOverview = (data: UsageInsights, metric: "cost" | "tokens" = "cost") => flushSync(() => {
  root.render(createElement(Overview, { data, metric }));
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
});
