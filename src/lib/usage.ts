import type { Bot, TaskUsage } from "@/state/store";
import { activeLocale, intlLocale, t } from "./i18n";

export const EMPTY_USAGE: TaskUsage = { input: 0, output: 0, costUsd: null, turns: 0 };
type TokenUsage = Pick<TaskUsage, "input" | "output"> & Partial<TaskUsage>;

export function hasFiniteCost(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

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

export function formatTokens(n: number): string {
  if (!hasFiniteCost(n)) return "0";
  if (n < 1000) return String(n);
  // Round first: 999,500 and up would otherwise print as "1000k" instead of "1M".
  if (Math.round(n / 1000) < 1000) return `${trim(n / 1000)}k`;
  return `${trim(n / 1_000_000)}M`;
}
const trim = (x: number) => (x >= 100 ? Math.round(x).toString() : x.toFixed(1).replace(/\.0$/, ""));

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

export const usdText = (usd: number, digits: number): string => activeLocale() === "en"
  ? `$${usd.toFixed(digits)}`
  : new Intl.NumberFormat(intlLocale(), { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false }).format(usd);

export function formatUsd(usd: number): string {
  if (!hasFiniteCost(usd)) return "";
  return usdText(usd, usd === 0 ? 0 : usd < 0.01 ? 3 : 2);
}

/** Clamped to `input`: some providers report cache reads outside their input figure. */
export function cachedInput(u: TokenUsage): number {
  return hasFiniteCost(u.cachedInput) ? Math.min(Math.max(0, u.cachedInput), u.input) : 0;
}

export function usageDetail(u: TokenUsage): string {
  const input = cachedKnown(u)
    ? `${t("chat.usage.uncachedInput", { tokens: formatTokens(uncachedInput(u)) })} · ${t("chat.usage.cachedInput", { tokens: formatTokens(cachedInput(u)) })}`
    : t("chat.usage.totalInput", { tokens: formatTokens(u.input) });
  return `${input} · ${t("chat.usage.output", { tokens: formatTokens(u.output) })}`;
}

export function uncachedInput(u: TokenUsage): number {
  return Math.max(0, u.input - cachedInput(u));
}

export function freshTokens(u: TaskUsage): number {
  return uncachedInput(u) + u.output;
}

export function headlineTokens(u: TaskUsage): number {
  return cachedKnown(u) ? freshTokens(u) : u.input + u.output;
}

export function cachedKnown(u: Pick<TaskUsage, "cachedInput">): boolean {
  return hasFiniteCost(u.cachedInput);
}

export function tokensColumnLabel(total: TaskUsage): string {
  return t(cachedKnown(total) ? "usage.colNewTokens" : "usage.colTokens");
}

export function cachedUsageNote(total: TaskUsage): string | null {
  const cached = cachedInput(total);
  if (cached <= 0) return null;
  return t("usage.cachedNote", {
    cached: formatTokens(cached),
    total: formatTokens(total.input + total.output),
  });
}

export type ContextTone = "quiet" | "warning" | "danger";

export function contextShare(u: TaskUsage): { tokens: number; window?: number; percent?: number; tone: ContextTone } | null {
  const ctx = u.context;
  if (!ctx || !hasFiniteCost(ctx.tokens) || ctx.tokens <= 0) return null;
  const window = hasFiniteCost(ctx.window) && ctx.window > 0 ? ctx.window : undefined;
  const percent = window ? Math.min(999, Math.round((ctx.tokens / window) * 100)) : undefined;
  const tone: ContextTone = percent === undefined ? "quiet" : percent >= 80 ? "danger" : percent >= 50 ? "warning" : "quiet";
  return { tokens: ctx.tokens, window, percent, tone };
}

export function contextChip(u: TaskUsage): string {
  const share = contextShare(u);
  if (!share) return "";
  return t("chat.usage.contextShort", { value: share.percent === undefined ? formatTokens(share.tokens) : `${share.percent}%` });
}

export function contextDetail(u: TaskUsage): string | null {
  const share = contextShare(u);
  if (!share) return null;
  return share.window && share.percent !== undefined
    ? t("chat.usage.contextOfWindow", { tokens: formatTokens(share.tokens), percent: String(share.percent), window: formatTokens(share.window) })
    : t("chat.usage.context", { tokens: formatTokens(share.tokens) });
}

export function lastTurnDetail(u: TaskUsage): string | null {
  const last = u.lastTurn;
  if (!last || !hasFiniteCost(last.input)) return null;
  return t("chat.usage.lastTurnSplit", { detail: usageDetail(last) });
}

export function usageChip(u: TaskUsage): string {
  if (u.turns === 0 && u.input + u.output === 0) return "";
  if (hasFiniteCost(u.costUsd)) return formatUsd(u.costUsd);
  if (cachedKnown(u)) return t("chat.usage.uncachedShort", { tokens: formatTokens(uncachedInput(u)) });
  return t("chat.usage.inputShort", { tokens: formatTokens(u.input) });
}

export function costCaption(billing: "metered" | "subscription" | undefined): string {
  if (billing === "subscription") return t("chat.usage.captionSubscription");
  if (billing === "metered") return t("chat.usage.captionMetered");
  return t("chat.usage.captionEngine");
}
