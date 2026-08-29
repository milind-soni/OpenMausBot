// Turning banked token/cost figures into something a header chip can show.
// Pure, so the numbers can be tested without the components.
import type { Bot, TaskUsage } from "@/state/store";
import type { LiveTokenUsage } from "../../server/contracts.ts";
import { estimateModelCost, type ModelPricing } from "../../shared/model-pricing";

export const EMPTY_USAGE: TaskUsage = { input: 0, output: 0, costUsd: null, turns: 0, tokenTurns: 0 };

export type UsageCostPresentation =
  | { readonly kind: "reported"; readonly usd: number }
  | {
      readonly kind: "estimated";
      readonly usd: number;
      readonly pricingSource: string;
      readonly precision: "exact" | "qualified";
      readonly qualification?: "cached_input_not_reported" | "long_context_not_reported";
    }
  | { readonly kind: "unknown"; readonly reason: "missing_pricing" | "missing_usage" };

export interface CostMenuTotals {
  readonly actualUsd: number | null;
  readonly predictedUsd: number | null;
}

export interface CostMenuSummary {
  readonly allTime: CostMenuTotals;
  readonly batch: CostMenuTotals;
  readonly daily: CostMenuTotals;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCostMenuTotals(value: unknown): value is CostMenuTotals {
  if (!isRecord(value)) return false;
  const valid = (amount: unknown): amount is number | null => amount === null || (typeof amount === "number" && Number.isFinite(amount));
  return valid(value.actualUsd) && valid(value.predictedUsd);
}

export function parseCostMenuSummary(value: unknown): CostMenuSummary | null {
  if (!isRecord(value)) return null;
  if (!isCostMenuTotals(value.allTime) || !isCostMenuTotals(value.batch) || !isCostMenuTotals(value.daily)) return null;
  return { allTime: value.allTime, batch: value.batch, daily: value.daily };
}

const cleanTokenCount = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;

/** Overlay ephemeral provider telemetry onto the persisted settled tally.
 * Thread-scoped reports replace the settled token totals; turn-scoped
 * reports extend them. Nothing here mutates or banks the durable record. */
export function taskUsageWithLive(
  settled: TaskUsage | undefined,
  live: LiveTokenUsage | undefined,
): TaskUsage | undefined {
  if (!live) return settled;
  const base = settled ?? EMPTY_USAGE;
  const input = cleanTokenCount(live.input);
  const output = cleanTokenCount(live.output);
  const turns = base.turns + 1;
  return {
    ...base,
    input: live.scope === "thread" ? Math.max(base.input, input) : base.input + input,
    output: live.scope === "thread" ? Math.max(base.output, output) : base.output + output,
    ...(live.cachedInput === undefined ? {} : { cachedInput: live.scope === "thread" ? Math.max(base.cachedInput ?? 0, cleanTokenCount(live.cachedInput)) : (base.cachedInput ?? 0) + cleanTokenCount(live.cachedInput) }),
    ...(live.contextTokens === undefined ? {} : { contextTokens: cleanTokenCount(live.contextTokens) }),
    turns,
    tokenTurns: Math.min(turns, reportedTokenTurns(base) + 1),
  };
}

/** Drop the ephemeral running indicator after the terminal event has been
 * projected into the durable task tally. */
export function clearLiveUsage(
  liveUsage: Record<string, LiveTokenUsage>,
  threadId: string,
): Record<string, LiveTokenUsage> {
  if (!(threadId in liveUsage)) return liveUsage;
  const { [threadId]: _removed, ...remaining } = liveUsage;
  return remaining;
}

/** Prefer a settled engine-reported cost. Otherwise estimate only from actual
 * token counts and the exact selected model card. */
export function usageCost(
  settled: TaskUsage | undefined,
  live: LiveTokenUsage | undefined,
  pricing: ModelPricing | undefined,
): UsageCostPresentation {
  if (settled && hasFiniteCost(settled.costUsd)) return { kind: "reported", usd: settled.costUsd };
  if (!pricing) return { kind: "unknown", reason: "missing_pricing" };
  const base = settled ?? EMPTY_USAGE;
  const input = live
    ? live.scope === "thread" ? Math.max(0, cleanTokenCount(live.input) - cleanTokenCount(base.input)) : cleanTokenCount(live.input)
    : cleanTokenCount(base.input);
  const output = live
    ? live.scope === "thread" ? Math.max(0, cleanTokenCount(live.output) - cleanTokenCount(base.output)) : cleanTokenCount(live.output)
    : cleanTokenCount(base.output);
  const hasUsage = live !== undefined || reportedTokenTurns(base) === base.turns;
  if (!hasUsage || (input === 0 && output === 0 && base.turns > 0)) return { kind: "unknown", reason: "missing_usage" };
  const cachedInput = live
    ? live.scope === "thread" ? Math.max(0, cleanTokenCount(live.cachedInput ?? 0) - cleanTokenCount(base.cachedInput ?? 0)) : cleanTokenCount(live.cachedInput ?? 0)
    : cleanTokenCount(base.cachedInput ?? 0);
  const estimate = estimateModelCost(pricing, {
    input,
    output,
    ...(live?.cachedInput !== undefined || base.cachedInput !== undefined ? { cachedInput } : {}),
    ...(live?.contextTokens !== undefined || base.contextTokens !== undefined ? { contextTokens: live?.contextTokens ?? base.contextTokens } : {}),
  });
  if (!estimate) return { kind: "unknown", reason: "missing_pricing" };
  return {
    kind: "estimated",
    usd: estimate.usd,
    pricingSource: pricing.source,
    precision: estimate.precision,
    ...(estimate.qualification ? { qualification: estimate.qualification } : {}),
  };
}

/** True when a stored cost is a real number (not null, NaN, or Infinity). */
export function hasFiniteCost(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Sum a set of usages; cost stays null until any of them has one. */
export function sumUsage(items: Array<TaskUsage | undefined>): TaskUsage {
  const out: TaskUsage = { ...EMPTY_USAGE };
  for (const u of items) {
    if (!u) continue;
    out.input += u.input;
    out.output += u.output;
    out.turns += u.turns;
    out.tokenTurns = (out.tokenTurns ?? 0) + reportedTokenTurns(u);
    const estimate = typeof u.estimatedTokens === "number" && Number.isFinite(u.estimatedTokens)
      ? Math.max(0, u.estimatedTokens)
      : 0;
    if (estimate > 0) out.estimatedTokens = (out.estimatedTokens ?? 0) + estimate;
    if (hasFiniteCost(u.costUsd)) out.costUsd = (out.costUsd ?? 0) + u.costUsd;
  }
  return out;
}

/** Legacy positive totals predate tokenTurns and came only from engines that
 * reported usage. A zero total with settled turns must remain unknown—not 0. */
export function reportedTokenTurns(u: TaskUsage): number {
  if (typeof u.tokenTurns === "number" && Number.isFinite(u.tokenTurns)) {
    return Math.max(0, Math.min(u.turns, Math.trunc(u.tokenTurns)));
  }
  return u.input + u.output > 0 ? u.turns : 0;
}

export type TokenUsagePresentation =
  | { kind: "empty"; tokens: 0 }
  | { kind: "reported"; tokens: number }
  | { kind: "estimated"; tokens: number; reportedTurns: number; totalTurns: number; estimateSource: "persisted" | "fallback" };

/** Cursor and a few subscription-backed engines omit usage telemetry. Give
 * the user a useful, visibly approximate figure instead of pretending those
 * turns cost zero. When some turns are measured, their average is the best
 * local predictor for the missing turns. With no measurements, use a
 * deliberately modest agent-turn baseline (prompt, tools and reply). */
export function tokenUsagePresentation(u: TaskUsage): TokenUsagePresentation {
  const turns = Number.isFinite(u.turns) ? Math.max(0, Math.trunc(u.turns)) : 0;
  const measured = Math.max(0, u.input + u.output);
  if (turns === 0 && measured === 0) return { kind: "empty", tokens: 0 };
  const reportedTurns = reportedTokenTurns(u);
  if (reportedTurns >= turns) return { kind: "reported", tokens: measured };
  const measuredPerTurn = reportedTurns > 0 && measured > 0 ? measured / reportedTurns : 2_000;
  const persistedEstimate = typeof u.estimatedTokens === "number" && Number.isFinite(u.estimatedTokens)
    ? Math.max(0, u.estimatedTokens)
    : 0;
  const tokens = Math.round(measured + (persistedEstimate > 0 ? persistedEstimate : (turns - reportedTurns) * measuredPerTurn));
  return { kind: "estimated", tokens, reportedTurns, totalTurns: turns, estimateSource: persistedEstimate > 0 ? "persisted" : "fallback" };
}

export function tokenUsageLabel(u: TaskUsage): string {
  const presentation = tokenUsagePresentation(u);
  if (presentation.kind === "empty") return "0";
  const label = formatTokens(presentation.tokens);
  return presentation.kind === "estimated" ? `~${label} (est.)` : label;
}

export function botUsage(bot: Pick<Bot, "tasks">): TaskUsage {
  return sumUsage((bot.tasks ?? []).map((t) => t.usage));
}

/** 950 → "950", 12_400 → "12.4k", 2_300_000 → "2.3M" */
export function formatTokens(n: number): string {
  if (!hasFiniteCost(n)) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${trim(n / 1000)}k`;
  return `${trim(n / 1_000_000)}M`;
}
const trim = (x: number) => (x >= 100 ? Math.round(x).toString() : x.toFixed(1).replace(/\.0$/, ""));

/** Dollars, with enough precision that a cheap turn isn't "$0.00". */
export function formatUsd(usd: number): string {
  if (!hasFiniteCost(usd)) return "";
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function actualExpectedLabel(totals: CostMenuTotals): string {
  const actual = hasFiniteCost(totals.actualUsd) ? formatUsd(totals.actualUsd) : "—";
  const expected = hasFiniteCost(totals.predictedUsd) ? `~${formatUsd(totals.predictedUsd)}` : "~—";
  return `${actual} actual / ${expected} expected`;
}

/** Compact cost rail copy. The first pair is the account total; batch and
 * today's total remain visible so a cheap-looking job cannot hide the bill. */
export function costMenuLabel(summary: CostMenuSummary): string {
  return `${actualExpectedLabel(summary.allTime)} · batch ${actualExpectedLabel(summary.batch)} · today ${actualExpectedLabel(summary.daily)}`;
}

/** Empty cost-ledger snapshots must not mask live or settled task usage in the
 * header. A null total means the ledger has no evidence for that scope. */
export function hasCostMenuData(summary: CostMenuSummary | undefined): boolean {
  if (!summary) return false;
  return [summary.allTime, summary.batch, summary.daily].some((totals) => (
    hasFiniteCost(totals.actualUsd) || hasFiniteCost(totals.predictedUsd)
  ));
}

/** The chip text: tokens, and cost when known. Empty string when nothing
 * has been spent — a fresh task shows no chip. */
export function usageChip(u: TaskUsage, cost?: UsageCostPresentation): string {
  const presentation = tokenUsagePresentation(u);
  if (presentation.kind === "empty") return "";
  const parts = [presentation.kind === "estimated"
    ? `~${formatTokens(presentation.tokens)} tok · est`
    : `${formatTokens(presentation.tokens)} tok`];
  if (cost?.kind === "reported") parts.push(formatUsd(cost.usd));
  else if (cost?.kind === "estimated") parts.push(`~${formatUsd(cost.usd)}`);
  else if (!cost && hasFiniteCost(u.costUsd)) parts.push(formatUsd(u.costUsd));
  return parts.join(" · ");
}

/** How to caption a cost figure given how the engine is billed. */
export function costCaption(billing: "metered" | "subscription" | undefined): string {
  if (billing === "subscription") return "equivalent — on your subscription, not billed";
  if (billing === "metered") return "billed to your API key";
  return "as reported by the engine";
}
