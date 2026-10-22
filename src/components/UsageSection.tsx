import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, Download, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { activeLocale, documentLanguage, t } from "@/lib/i18n";
import { listenLiveFrames } from "@/lib/live-events";
import { formatTokens, hasFiniteCost, headlineTokens } from "@/lib/usage";
import { fetchTraces, formatCost, formatDuration, USAGE_PERIODS, usageExportHref, usagePeriodRange, type UsagePeriod } from "@/lib/usage-trace";
import { api, useStore } from "@/state/store";
import type { LocaleKey } from "@/locales";
import type { TraceList, TraceRootSummary } from "../../shared/usage-trace";
import { BotAvatar } from "./Avatar";
import { PlanUsage } from "./PlanUsage";
import { Select } from "./Select";
import { UsageBudgetCards, type BudgetState } from "./UsageBudget";
import { TraceView } from "./usage/TraceView";
import { LiveBadge, modelName, StatStrip, totalsStats } from "./usage/TraceWaterfall";

export type UsageGroupBy = "bot" | "model" | "user" | "day" | "engine" | "routine";
const OTHER_GROUPINGS: readonly UsageGroupBy[] = ["model", "user", "day", "engine", "routine"];

export interface UsageGroup {
  key: string;
  label: string;
  turns: number;
  input: number;
  output: number;
  cachedInput: number;
  costUsd: number | null;
}

interface UsageSummary {
  groupBy: UsageGroupBy;
  groups: UsageGroup[];
  budget?: BudgetState | null;
}

const GROUP_LABEL_KEYS: Record<UsageGroupBy, LocaleKey> = {
  bot: "usage.history.byBot",
  model: "usage.history.byModel",
  user: "usage.history.byUser",
  day: "usage.history.byDay",
  engine: "usage.history.byEngine",
  routine: "usage.history.byRoutine",
};

const PERIOD_LABEL_KEYS: Record<UsagePeriod, LocaleKey> = {
  today: "usage.page.today",
  week: "usage.page.week",
  month: "usage.history.thisMonth",
  lastMonth: "usage.history.lastMonth",
  days30: "usage.history.last30Days",
};

const LIVE_REFRESH_MS = 2_000;

export function usageGroupLabel(groupBy: UsageGroupBy, group: Pick<UsageGroup, "key" | "label">): string {
  if (groupBy === "routine") return group.key === "manual" ? t("usage.history.notRoutine") : group.label;
  if (groupBy !== "user") return group.label;
  if (group.key === "owner") return t("usage.history.owner");
  if (group.key === "bot") return t("usage.history.botToBot");
  if (group.key.startsWith("routine:")) return t("usage.history.routine", { name: group.label.replace(/^Routine: /, "") });
  return group.label;
}

function useUsageGroups(range: { from: string; to: string }, groupBy: UsageGroupBy, version: number): UsageSummary | null {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  useEffect(() => {
    let current = true;
    void api(`/api/usage?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}&groupBy=${groupBy}`)
      .then((next: UsageSummary) => { if (current) setSummary(next); })
      .catch(() => { if (current) setSummary(null); });
    return () => { current = false; };
  }, [range.from, range.to, groupBy, version]);
  return summary;
}

export function GroupBars({ groupBy, groups }: { groupBy: UsageGroupBy; groups: readonly UsageGroup[] }) {
  const { state } = useStore();
  const priced = groups.some((group) => hasFiniteCost(group.costUsd) && group.costUsd > 0);
  const value = (group: UsageGroup) => priced ? group.costUsd ?? 0 : headlineTokens(group);
  const top = [...groups].sort((a, b) => value(b) - value(a)).slice(0, 6);
  const max = Math.max(...top.map(value), 0);
  if (!top.length || max <= 0) return <p className="text-[13px] text-ink-secondary">{t("usage.page.whereEmpty")}</p>;
  return (
    <ul className="flex flex-col gap-2.5">
      {top.map((group) => {
        const bot = groupBy === "bot" ? state.bots.find((item) => `bot:${item.id}` === group.key) : undefined;
        return (
          <li key={group.key} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 text-[13px]" title={t("usage.page.turns", { count: String(group.turns) })}>
            <span className="flex min-w-0 items-center gap-2 text-ink">
              {bot && <BotAvatar bot={bot} state="idle" size={18} animated={false} />}
              <span className="truncate">{groupBy === "model" ? modelName(group.label, state.instances) : usageGroupLabel(groupBy, group)}</span>
            </span>
            <span className="h-2 overflow-hidden rounded-full bg-raised">
              <span className="block h-full rounded-full bg-accent/70" style={{ width: `${Math.max(2, (value(group) / max) * 100)}%` }} />
            </span>
            <span className="min-w-[4.5rem] text-right tabular-nums text-ink-secondary">
              {priced ? formatCost(group.costUsd) : formatTokens(headlineTokens(group))}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function WhereItWent({ range, version, onBudget }: { range: { from: string; to: string }; version: number; onBudget: (budget: BudgetState | null) => void }) {
  const [other, setOther] = useState<UsageGroupBy>("model");
  const byBot = useUsageGroups(range, "bot", version);
  const byOther = useUsageGroups(range, other, version);
  useEffect(() => { onBudget(byBot?.budget ?? null); }, [byBot, onBudget]);
  return (
    <section className="rounded-2xl border border-hairline/50 bg-card p-5" aria-label={t("usage.page.where")}>
      <h3 className="text-[15px] font-medium text-ink">{t("usage.page.where")}</h3>
      <div className="mt-4 grid gap-6 md:grid-cols-2">
        <div>
          <div className="mb-3 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-secondary">{t(GROUP_LABEL_KEYS.bot)}</div>
          {byBot ? <GroupBars groupBy="bot" groups={byBot.groups} /> : <Loader2 size={14} className="animate-spin text-ink-secondary" />}
        </div>
        <div>
          <div role="tablist" aria-label={t("usage.history.groupBy")} className="-mt-1 mb-2 flex flex-wrap gap-1">
            {OTHER_GROUPINGS.map((option) => (
              <button
                key={option}
                type="button"
                role="tab"
                aria-selected={other === option}
                onClick={() => setOther(option)}
                className={cn("rounded-md px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.06em]",
                  other === option ? "bg-accent/12 text-accent" : "text-ink-secondary hover:bg-raised/60 hover:text-ink")}
              >{t(GROUP_LABEL_KEYS[option])}</button>
            ))}
          </div>
          {byOther?.groupBy === other ? <GroupBars groupBy={other} groups={byOther.groups} /> : <Loader2 size={14} className="animate-spin text-ink-secondary" />}
        </div>
      </div>
    </section>
  );
}

function startedLabel(at: number): string {
  return new Date(at).toLocaleString(documentLanguage(activeLocale()), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function RunRow({ root, onOpen }: { root: TraceRootSummary; onOpen: () => void }) {
  const { state } = useStore();
  const title = root.title || t(`trace.source.${root.source}`, { bot: root.bots[0]?.name ?? "" });
  return (
    <li>
      <button type="button" onClick={onOpen} className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-raised/50" data-testid="usage-run">
        <span className="flex w-[38px] shrink-0 -space-x-1.5 sm:w-[74px]">
          {root.bots.slice(0, 4).map((entry, index) => {
            const bot = state.bots.find((item) => item.id === entry.id);
            return bot
              ? <span key={entry.id} className={cn("rounded-full ring-2 ring-card", index > 1 && "hidden sm:block")}><BotAvatar bot={bot} state="idle" size={22} animated={false} /></span>
              : <span key={entry.id} className={cn("flex size-[22px] items-center justify-center rounded-full bg-raised text-[10px] font-semibold text-ink-secondary ring-2 ring-card", index > 1 && "hidden sm:flex")}>{entry.name.slice(0, 1).toUpperCase()}</span>;
          })}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[13.5px] text-ink">{title}</span>
          <span className="block truncate text-[12px] text-ink-tertiary">{startedLabel(root.startedAt)} · {root.bots.map((bot) => bot.name).join(", ")}</span>
        </span>
        <span className="flex items-center gap-3 text-[12.5px] tabular-nums text-ink-secondary">
          {root.running && <LiveBadge />}
          {root.errors > 0 && <span className="rounded-md bg-danger/12 px-1.5 py-0.5 text-[11.5px] font-medium text-danger">{t("trace.groupErrors", { count: String(root.errors) })}</span>}
          {root.timed ? <span className="hidden min-w-[3.5rem] text-right sm:inline">{formatDuration(root.durationMs)}</span>
            : <span className="hidden rounded bg-raised px-1.5 text-[11px] sm:inline">{t("trace.notTimed")}</span>}
          <span className="min-w-[3.5rem] text-right text-ink">{formatCost(root.costUsd)}</span>
          <ChevronRight size={14} className="text-ink-tertiary" />
        </span>
      </button>
    </li>
  );
}

/** The Usage page: a period's totals, where the money went, and every run as a trace. */
export function UsageSection() {
  const [period, setPeriod] = useState<UsagePeriod>("month");
  const range = useMemo(() => usagePeriodRange(period), [period]);
  const [list, setList] = useState<TraceList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [budget, setBudget] = useState<BudgetState | null>(null);
  const [open, setOpen] = useState<{ id: string; at: number } | null>(null);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let current = true;
    void fetchTraces(range)
      .then((next) => { if (current) { setList(next); setError(null); } })
      .catch((cause) => { if (current) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { current = false; };
  }, [range, version]);

  useEffect(() => listenLiveFrames({
    onFrame: (frame) => {
      if (frame.kind !== "runtime" || pending.current) return;
      const type = (frame.event as { type?: string } | undefined)?.type;
      if (type !== "turn.started" && type !== "turn.completed") return;
      pending.current = setTimeout(() => { pending.current = null; setVersion((value) => value + 1); }, LIVE_REFRESH_MS);
    },
    onMissedFrames: () => setVersion((value) => value + 1),
  }), []);
  useEffect(() => () => { if (pending.current) clearTimeout(pending.current); }, []);

  const more = () => {
    if (!list?.next) return;
    void fetchTraces(range, list.next).then((page) => setList((current) => current ? { ...page, roots: [...current.roots, ...page.roots] } : page));
  };
  const untimed = list?.roots.some((root) => !root.timed);

  return (
    <div className="flex flex-col gap-4" data-testid="usage-page">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
        <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-ink-secondary">{t("usage.page.subtitle")}</p>
        <div className="flex items-center gap-2">
          <Select size="sm" value={period} onChange={(event) => { setPeriod(event.target.value as UsagePeriod); setOpen(null); }} aria-label={t("usage.history.period")}>
            {USAGE_PERIODS.map((option) => <option key={option} value={option}>{t(PERIOD_LABEL_KEYS[option])}</option>)}
          </Select>
          <a href={usageExportHref(range)} download className="flex items-center gap-1.5 rounded-lg border border-hairline/40 px-2.5 py-1 text-[12px] text-ink-secondary hover:bg-raised/50 hover:text-ink">
            <Download size={13} />{t("usage.history.export")}
          </a>
        </div>
      </div>
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
      {open ? (
        <TraceView id={open.id} at={open.at} actions={(
          <button type="button" onClick={() => setOpen(null)} className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink">
            <ArrowLeft size={13} />{t("trace.back")}
          </button>
        )} />
      ) : (
        <>
          <section className="overflow-hidden rounded-2xl border border-hairline/50 bg-card" data-testid="usage-totals">
            {list ? <StatStrip items={totalsStats(list.totals, t("trace.stat.time"))} />
              : <div className="flex items-center gap-2 p-5 text-[13px] text-ink-secondary"><Loader2 size={14} className="animate-spin" />{t("common.checking")}</div>}
          </section>
          <WhereItWent range={range} version={version} onBudget={setBudget} />
          <section className="rounded-2xl border border-hairline/50 bg-card p-2" aria-label={t("usage.page.runs")}>
            <div className="px-3 pb-1 pt-3">
              <h3 className="text-[15px] font-medium text-ink">{t("usage.page.runs")}</h3>
              <p className="mt-0.5 text-[13px] text-ink-secondary">{t("usage.page.runsHint")}</p>
            </div>
            {list && !list.roots.length && <p className="px-3 py-3 text-[13px] text-ink-secondary">{t("usage.page.runsEmpty")}</p>}
            <ul className="mt-1 flex flex-col">
              {list?.roots.map((root) => <RunRow key={root.id} root={root} onOpen={() => setOpen({ id: root.id, at: root.startedAt })} />)}
            </ul>
            {list?.next !== undefined && (
              <button type="button" onClick={more} className="m-2 rounded-lg px-3 py-1.5 text-[12.5px] text-accent hover:bg-raised/50">{t("usage.page.more")}</button>
            )}
            {untimed && <p className="px-3 pb-3 pt-1 text-[12px] text-ink-tertiary">{t("usage.page.untimedNote")}</p>}
          </section>
        </>
      )}
      <PlanUsage />
      <UsageBudgetCards budget={budget} />
    </div>
  );
}
