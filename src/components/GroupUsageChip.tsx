import type { GroupThreadUsage } from "../../shared/wire";
import { formatTokens, formatUsd, hasFiniteCost } from "@/lib/usage";
import { t } from "@/lib/i18n";

function breakdown(usage: { input: number; output: number; cachedInput?: number }) {
  const output = t("room.usage.output", { tokens: formatTokens(usage.output) });
  if (!hasFiniteCost(usage.cachedInput)) return `${t("room.usage.inputUnknown", { tokens: formatTokens(usage.input) })} · ${output}`;
  const cached = Math.min(usage.input, Math.max(0, usage.cachedInput));
  return `${t("room.usage.uncached", { tokens: formatTokens(usage.input - cached) })} · ${t("room.usage.cached", { tokens: formatTokens(cached) })} · ${output}`;
}

export function groupUsageSummary(usage?: GroupThreadUsage | null): { short: string; title: string } | null {
  if (!usage?.turns) return null;
  const title = [
    t("room.usage.total", { details: breakdown(usage) }),
    usage.lastTurn ? t("room.usage.last", { name: usage.lastSpeaker?.name ?? "", details: breakdown(usage.lastTurn) }) : null,
    hasFiniteCost(usage.costUsd) ? t("room.usage.cost", { cost: formatUsd(usage.costUsd) }) : null,
  ].filter(Boolean).join("\n");
  const short = hasFiniteCost(usage.costUsd) ? formatUsd(usage.costUsd)
    : hasFiniteCost(usage.cachedInput) ? t("room.usage.uncached", { tokens: formatTokens(Math.max(0, usage.input - usage.cachedInput)) })
      : t("room.usage.input", { tokens: formatTokens(usage.input) });
  return { short, title };
}

export function GroupUsageChip({ usage }: { usage?: GroupThreadUsage | null }) {
  const summary = groupUsageSummary(usage);
  if (!summary) return null;
  return <span tabIndex={0} title={summary.title} aria-label={summary.title} data-testid="group-usage-chip"
    className="shrink-0 rounded-full bg-raised px-2.5 py-1 text-[12px] tabular-nums text-ink-secondary">{summary.short}</span>;
}
