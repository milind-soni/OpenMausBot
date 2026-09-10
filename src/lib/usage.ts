// Turning banked token/cost figures into something a header chip can show.
// Pure, so the numbers can be tested without the components.
import type { Bot, TaskUsage } from "@/state/store";
import { t } from "./i18n";

export const EMPTY_USAGE: TaskUsage = { input: 0, output: 0, costUsd: null, turns: 0 };

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
  if (n < 1000) return n === 1 ? t("usage.tokenOne") : t("usage.tokenMany", { count: n });
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
export function cachedInput(u: TaskUsage): number {
  return hasFiniteCost(u.cachedInput) ? Math.min(Math.max(0, u.cachedInput), u.input) : 0;
}

/** The in/out breakdown behind the headline figure, with the cached share
 * called out when there is one: "88.2k in (79k cached) · 1.2k out". The
 * headline counts every token the model processed — five short messages
 * on a thread with a system prompt and tool schemas really do cost the
 * model ~17k tokens of reading each turn — so the breakdown is where the
 * "was that really 100k?" question gets answered. */
export function usageDetail(u: TaskUsage): string {
  const cached = cachedInput(u);
  const input =
    cached > 0
      ? t("chat.usage.inCached", { tokens: formatTokens(u.input), cached: formatTokens(cached) })
      : t("chat.usage.in", { tokens: formatTokens(u.input) });
  return `${input} · ${t("chat.usage.out", { tokens: formatTokens(u.output) })}`;
}

/** The chip text: tokens, and cost when known. Empty string when nothing
 * has been spent — a fresh task shows no chip. */
export function usageChip(u: TaskUsage): string {
  if (u.turns === 0 && u.input + u.output === 0) return "";
  const parts = [t("chat.usage.tokens", { tokens: formatTokens(u.input + u.output) })];
  if (hasFiniteCost(u.costUsd)) parts.push(formatUsd(u.costUsd));
  return parts.join(" · ");
}

/** How to caption a cost figure given how the engine is billed. */
export function costCaption(billing: "metered" | "subscription" | undefined): string {
  if (billing === "subscription") return t("chat.usage.captionSubscription");
  if (billing === "metered") return t("chat.usage.captionMetered");
  return t("chat.usage.captionEngine");
}
