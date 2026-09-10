// App settings → Usage → History: what this workspace spent over a period,
// by bot, model, person, day or engine, from the server's month-by-month
// ledger (server/usage-ledger.ts). The card above it sums live tasks; this
// one survives restarts and exports for an invoice.
import { useEffect, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { api } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { formatTokens, formatUsd, hasFiniteCost } from "@/lib/usage";
import { Card } from "./SettingsPrimitives";
import { UsageBudgetCards, type BudgetState } from "./UsageBudget";

export type UsageGroupBy = "bot" | "model" | "user" | "day" | "engine";
export const USAGE_GROUPINGS: readonly UsageGroupBy[] = ["bot", "model", "user", "day", "engine"];
export type UsagePeriod = "month" | "lastMonth" | "days30";

export interface UsageGroup {
  key: string;
  label: string;
  turns: number;
  input: number;
  output: number;
  cachedInput: number;
  costUsd: number | null;
  unpriced: number;
  /** the operator's own price, when a list is set and the server is entitled */
  billableUsd?: number | null;
}

export interface UsageSummary {
  from: string;
  to: string;
  groupBy: UsageGroupBy;
  groups: UsageGroup[];
  total: UsageGroup;
  budget?: BudgetState | null;
  billing?: { currency: string } | null;
}

/** Inclusive day bounds (UTC) for a preset period. */
export function usagePeriodRange(period: UsagePeriod, now = new Date()): { from: string; to: string } {
  const day = (date: Date) => date.toISOString().slice(0, 10);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  if (period === "month") return { from: day(new Date(Date.UTC(year, month, 1))), to: day(now) };
  if (period === "lastMonth") return { from: day(new Date(Date.UTC(year, month - 1, 1))), to: day(new Date(Date.UTC(year, month, 0))) };
  return { from: day(new Date(now.getTime() - 29 * 24 * 60 * 60_000)), to: day(now) };
}

/** The server can only describe the non-person triggers in English; the
 * app names them itself by key. */
export function usageGroupLabel(groupBy: UsageGroupBy, group: UsageGroup): string {
  if (groupBy !== "user") return group.label;
  if (group.key === "owner") return t("usage.history.owner");
  if (group.key === "bot") return t("usage.history.botToBot");
  if (group.key.startsWith("routine:")) return t("usage.history.routine", { name: group.label.replace(/^Routine: /, "") });
  return group.label;
}

export function usageExportHref(range: { from: string; to: string }): string {
  return `/api/usage.csv?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
}

const GROUP_LABEL_KEYS: Record<UsageGroupBy, "usage.history.byBot" | "usage.history.byModel" | "usage.history.byUser" | "usage.history.byDay" | "usage.history.byEngine"> = {
  bot: "usage.history.byBot",
  model: "usage.history.byModel",
  user: "usage.history.byUser",
  day: "usage.history.byDay",
  engine: "usage.history.byEngine",
};

/** The table alone, so it renders the same from a fetch or a fixture. */
export function UsageHistoryTable({ summary }: { summary: UsageSummary }) {
  if (summary.groups.length === 0) {
    return <div className="text-[13px] text-ink-secondary">{t("usage.history.empty")}</div>;
  }
  const billable = Boolean(summary.billing);
  const columns = billable ? "grid grid-cols-[1fr_auto_auto_auto_auto] items-center gap-x-5" : "grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-5";
  const money = (value: number | null | undefined) => (hasFiniteCost(value) ? formatUsd(value) : "—");
  return (
    <div className="flex flex-col">
      <div className={cn(columns, "border-b border-hairline/40 pb-2 text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary")}>
        <span>{t(GROUP_LABEL_KEYS[summary.groupBy])}</span>
        <span className="text-right">{t("usage.colTurns")}</span>
        <span className="text-right">{t("usage.colTokens")}</span>
        <span className="text-right">{t("usage.colCost")}</span>
        {billable && <span className="text-right">{t("usage.history.colBillable")}</span>}
      </div>
      {summary.groups.map((group) => (
        <div key={group.key} className={cn(columns, "border-b border-hairline/20 py-2 text-[13px]")}>
          <span className="truncate text-ink" title={group.label}>{usageGroupLabel(summary.groupBy, group)}</span>
          <span className="text-right tabular-nums text-ink-secondary">{group.turns}</span>
          <span className="text-right tabular-nums text-ink" title={t("usage.history.tokenSplit", { input: formatTokens(group.input), output: formatTokens(group.output), cached: formatTokens(group.cachedInput) })}>
            {formatTokens(group.input + group.output)}
          </span>
          <span className="text-right tabular-nums text-ink">
            {hasFiniteCost(group.costUsd) ? formatUsd(group.costUsd) : <span className="text-ink-secondary">—</span>}
            {group.unpriced > 0 && hasFiniteCost(group.costUsd) && <span className="text-ink-secondary">*</span>}
          </span>
          {billable && <span className="text-right tabular-nums text-ink">{money(group.billableUsd)}</span>}
        </div>
      ))}
      <div className={cn(columns, "pt-2.5 text-[13px] font-medium text-ink")}>
        <span>{t("usage.history.total")}</span>
        <span className="text-right tabular-nums">{summary.total.turns}</span>
        <span className="text-right tabular-nums">{formatTokens(summary.total.input + summary.total.output)}</span>
        <span className="text-right tabular-nums">{hasFiniteCost(summary.total.costUsd) ? formatUsd(summary.total.costUsd) : "—"}</span>
        {billable && <span className="text-right tabular-nums">{money(summary.total.billableUsd)}</span>}
      </div>
      {summary.total.unpriced > 0 && (
        <div className="mt-3 text-[12px] leading-relaxed text-ink-secondary">{t("usage.history.unpriced", { count: String(summary.total.unpriced) })}</div>
      )}
    </div>
  );
}

async function fetchUsage(range: { from: string; to: string }, groupBy: UsageGroupBy): Promise<UsageSummary> {
  return api(`/api/usage?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}&groupBy=${groupBy}`);
}

export function UsageHistory({ load = fetchUsage }: { load?: typeof fetchUsage }) {
  const [period, setPeriod] = useState<UsagePeriod>("month");
  const [groupBy, setGroupBy] = useState<UsageGroupBy>("bot");
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const range = usagePeriodRange(period);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    load(usagePeriodRange(period), groupBy)
      .then((next) => { if (current) setSummary(next); })
      .catch((cause) => { if (current) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [period, groupBy, load]);

  return (
    <>
    <UsageBudgetCards budget={summary?.budget ?? null} />
    <Card title={t("usage.history.title")} subtitle={t("usage.history.subtitle")}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select
          value={period}
          onChange={(event) => setPeriod(event.target.value as UsagePeriod)}
          aria-label={t("usage.history.period")}
          className="rounded-lg border border-hairline/40 bg-inset px-2 py-1.5 text-[12.5px] text-ink focus:border-hairline focus:outline-none"
        >
          <option value="month">{t("usage.history.thisMonth")}</option>
          <option value="lastMonth">{t("usage.history.lastMonth")}</option>
          <option value="days30">{t("usage.history.last30Days")}</option>
        </select>
        <div role="tablist" aria-label={t("usage.history.groupBy")} className="flex flex-wrap gap-1">
          {USAGE_GROUPINGS.map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={groupBy === option}
              onClick={() => setGroupBy(option)}
              className={cn(
                "rounded-lg px-2.5 py-1 text-[12px]",
                groupBy === option ? "bg-accent/15 text-accent" : "text-ink-secondary hover:bg-raised/50 hover:text-ink",
              )}
            >
              {t(GROUP_LABEL_KEYS[option])}
            </button>
          ))}
        </div>
        <a
          href={usageExportHref(range)}
          download
          className="ml-auto flex items-center gap-1.5 rounded-lg border border-hairline/40 px-2.5 py-1 text-[12px] text-ink-secondary hover:bg-raised/50 hover:text-ink"
        >
          <Download size={13} />{t("usage.history.export")}
        </a>
      </div>
      {error && <p role="alert" className="mb-2 text-[12px] text-danger">{error}</p>}
      {loading && !summary ? (
        <div className="flex items-center gap-2 text-[13px] text-ink-secondary"><Loader2 size={14} className="animate-spin" />{t("common.checking")}</div>
      ) : summary ? (
        <UsageHistoryTable summary={summary} />
      ) : null}
    </Card>
    </>
  );
}
