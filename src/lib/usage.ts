// Turning banked token/cost figures into something a header chip can show.
// Pure, so the numbers can be tested without the components.
import type { Bot, TaskUsage } from "@/state/store";
import { t } from "./i18n";

export const EMPTY_USAGE: TaskUsage = { input: 0, output: 0, costUsd: null, turns: 0 };
type TokenUsage = Pick<TaskUsage, "input" | "output"> & Partial<TaskUsage>;

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
    if (hasFiniteCost(u.cachedInput)) out.cachedInput = (out.cachedInput ?? 0) + u.cachedInput;
    if (hasFiniteCost(u.costUsd)) out.costUsd = (out.costUsd ?? 0) + u.costUsd;
  }
  if (items.some((u) => u && u.input > 0 && !cachedKnown(u))) delete out.cachedInput;
  return out;
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

/** Task-picker variant: hide unused tasks and spell out small counts. */
export function formatTaskTokens(total: number): string | null {
  if (!Number.isFinite(total) || total < 1) return null;
  const n = Math.trunc(total);
  if (n < 1000) return n === 1 ? "1 token" : `${n} tokens`;
  const kTenths = Math.round(n / 100);
  if (kTenths < 10_000) return `${formatTenths(kTenths)}k`;
  return `${formatTenths(Math.round(n / 100_000))}M`;
}

const formatTenths = (value: number) => {
  const fraction = value % 10;
  return fraction === 0 ? `${value / 10}` : `${(value - fraction) / 10}.${fraction}`;
};

/** Dollars, with enough precision that a cheap turn isn't "$0.00". */
export function formatUsd(usd: number): string {
  if (!hasFiniteCost(usd)) return "";
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/** How much of `input` the provider served from its prompt cache. Clamped to
 * `input` so a provider that reports cache reads outside its input figure
 * can never produce a negative "fresh" number. */
export function cachedInput(u: TokenUsage): number {
  return hasFiniteCost(u.cachedInput) ? Math.min(Math.max(0, u.cachedInput), u.input) : 0;
}

/** Keep input and output separate; an absent cache count is not zero. */
export function usageDetail(u: TokenUsage): string {
  const input = cachedKnown(u)
    ? `${t("chat.usage.uncachedInput", { tokens: formatTokens(uncachedInput(u)) })} · ${t("chat.usage.cachedInput", { tokens: formatTokens(cachedInput(u)) })}`
    : t("chat.usage.totalInput", { tokens: formatTokens(u.input) });
  return `${input} · ${t("chat.usage.output", { tokens: formatTokens(u.output) })}`;
}

/** Callers use this only when the provider reported the cache split. */
export function uncachedInput(u: TokenUsage): number {
  return Math.max(0, u.input - cachedInput(u));
}

/** Non-cached input plus generated output for aggregate token counters.
 * This is a token count, not a price: cached input may still be billed. */
export function freshTokens(u: TaskUsage): number {
  return uncachedInput(u) + u.output;
}

/** Aggregate counters preserve the existing input-plus-output meaning.
 * Chat input chips label their narrower count explicitly. */
export function headlineTokens(u: TaskUsage): number {
  return cachedKnown(u) ? freshTokens(u) : u.input + u.output;
}

export function cachedKnown(u: Pick<TaskUsage, "cachedInput">): boolean {
  return hasFiniteCost(u.cachedInput);
}

export type ContextTone = "quiet" | "warning" | "danger";

/** The last model call's prompt against the model's window, with the same
 * thresholds ccusage's statusline uses: green under 50%, red over 80%. */
export function contextShare(u: TaskUsage): { tokens: number; window?: number; percent?: number; tone: ContextTone } | null {
  const ctx = u.context;
  if (!ctx || !hasFiniteCost(ctx.tokens) || ctx.tokens <= 0) return null;
  const window = hasFiniteCost(ctx.window) && ctx.window > 0 ? ctx.window : undefined;
  const percent = window ? Math.min(999, Math.round((ctx.tokens / window) * 100)) : undefined;
  const tone: ContextTone = percent === undefined ? "quiet" : percent >= 80 ? "danger" : percent >= 50 ? "warning" : "quiet";
  return { tokens: ctx.tokens, window, percent, tone };
}

/** "ctx 142k" or "ctx 52%": the compact form beside the headline. */
export function contextChip(u: TaskUsage): string {
  const share = contextShare(u);
  if (!share) return "";
  return t("chat.usage.contextShort", { value: share.percent === undefined ? formatTokens(share.tokens) : `${share.percent}%` });
}

/** "Context 142k (52% of 272k)" or "Context 142k". */
export function contextDetail(u: TaskUsage): string | null {
  const share = contextShare(u);
  if (!share) return null;
  return share.window && share.percent !== undefined
    ? t("chat.usage.contextOfWindow", { tokens: formatTokens(share.tokens), percent: String(share.percent), window: formatTokens(share.window) })
    : t("chat.usage.context", { tokens: formatTokens(share.tokens) });
}

/** The latest turn, with the same separate counts as the thread total. */
export function lastTurnDetail(u: TaskUsage): string | null {
  const last = u.lastTurn;
  if (!last || !hasFiniteCost(last.input)) return null;
  return t("chat.usage.lastTurnSplit", { detail: usageDetail(last) });
}

/** Cost when reported; otherwise input only. Output stays in the tooltip. */
export function usageChip(u: TaskUsage): string {
  if (u.turns === 0 && u.input + u.output === 0) return "";
  if (hasFiniteCost(u.costUsd)) return formatUsd(u.costUsd);
  if (cachedKnown(u)) return t("chat.usage.uncachedShort", { tokens: formatTokens(uncachedInput(u)) });
  return t("chat.usage.inputShort", { tokens: formatTokens(u.input) });
}

/** How to caption a cost figure given how the engine is billed. */
export function costCaption(billing: "metered" | "subscription" | undefined): string {
  if (billing === "subscription") return t("chat.usage.captionSubscription");
  if (billing === "metered") return t("chat.usage.captionMetered");
  return t("chat.usage.captionEngine");
}
