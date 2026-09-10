import { useState } from "react";
import { CircleAlert, FileText, Loader2, Search } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { RoutineRun } from "@/lib/routines";
import { routineDateTime, routineRunLabel, routineRunTime, routineRunTone } from "@/lib/routine-display";
import type { Bot } from "@/state/store";

export function RoutineLogs({ runs, bots, loading, error, routineId, onClearRoutine, onOpen }: {
  runs: RoutineRun[];
  bots: Bot[];
  loading?: boolean;
  error?: boolean;
  routineId?: string;
  onClearRoutine: () => void;
  onOpen: (run: RoutineRun) => void;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [limit, setLimit] = useState(50);
  const filtered = runs.filter((run) => (!routineId || run.routineId === routineId) && (status === "all" || run.status === status)
    && `${run.routineName} ${bots.find((bot) => bot.id === run.botId)?.name ?? ""} ${run.output ?? ""} ${run.error ?? ""} ${run.attention ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => routineRunTime(b) - routineRunTime(a));
  return <section className="mx-auto w-full max-w-5xl space-y-4 p-4 sm:p-6" aria-label={t("routines.logs")}>
    <div><h2 className="text-[17px] font-semibold text-ink">{t("routines.logs")}</h2><p className="mt-1 text-[12px] text-ink-secondary">{t("routines.logsHint")}</p></div>
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex min-w-[180px] flex-1 items-center gap-2 rounded-lg border border-hairline/50 bg-panel px-3 py-2 text-ink-secondary"><Search size={14} /><input aria-label={t("routines.searchLogs")} placeholder={t("routines.searchLogs")} value={query} onChange={(event) => { setQuery(event.target.value); setLimit(50); }} className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none" /></label>
      <select aria-label={t("routines.filterStatus")} value={status} onChange={(event) => { setStatus(event.target.value); setLimit(50); }} className="rounded-lg border border-hairline/50 bg-panel px-3 py-2 text-[12px] text-ink"><option value="all">{t("routines.allStatuses")}</option>{(["queued", "running", "waiting", "completed", "failed", "missed", "cancelled"] as const).map((value) => <option key={value} value={value}>{t(`routines.status.${value}`)}</option>)}</select>
    </div>
    {routineId && <div className="flex items-center gap-2 text-[12px] text-ink-secondary">{t("routines.filteredRoutine")}<button type="button" onClick={onClearRoutine} className="text-accent hover:underline">{t("routines.showAll")}</button></div>}
    {error && <p role="alert" className="flex items-center gap-2 rounded-lg bg-danger/10 p-3 text-[12px] text-danger"><CircleAlert size={14} />{t("routines.loadError")}</p>}
    {loading && <p role="status" className="flex items-center gap-2 text-[12px] text-ink-secondary"><Loader2 size={14} className="animate-spin" />{t("routines.loading")}</p>}
    {!loading && !error && filtered.length === 0 && <div className="rounded-xl border border-dashed border-hairline/50 p-10 text-center text-[13px] text-ink-secondary"><FileText size={24} className="mx-auto mb-3 opacity-50" />{runs.length ? t("routines.noMatchingRuns") : t("routines.noRuns")}</div>}
    <div className="space-y-2">{filtered.slice(0, limit).map((run) => {
      const bot = bots.find((candidate) => candidate.id === run.botId);
      return <button type="button" key={run.id} onClick={() => onOpen(run)} aria-label={t("routines.openRun", { name: run.routineName, status: routineRunLabel(run) })} className="block w-full rounded-xl border border-hairline/40 bg-card p-4 text-left hover:border-accent/40 hover:bg-raised/40">
        <div className="flex items-start justify-between gap-3"><div className="min-w-0"><span className="block truncate text-[13px] font-semibold text-ink">{run.routineName}</span><span className="mt-1 block text-[11px] text-ink-secondary">{bot?.name ?? t("routines.unavailableBot")} · {routineDateTime(run.scheduledFor)} · {t(`routines.trigger.${run.triggerSource ?? (run.manual ? "manual" : "schedule")}`)}</span></div><span className={cn("shrink-0 text-[11.5px] font-medium", routineRunTone(run))}>{routineRunLabel(run)}</span></div>
        <p className={cn("mt-2 line-clamp-2 whitespace-pre-wrap text-[12px] leading-relaxed", run.error ? "text-danger" : "text-ink-secondary")}>{run.attention || run.error || run.output || t("routines.noOutput")}</p>
      </button>;
    })}</div>
    {filtered.length > limit && <button type="button" onClick={() => setLimit((current) => current + 50)} className="rounded-lg bg-raised px-4 py-2 text-[12px] text-ink">{t("routines.loadMore")}</button>}
  </section>;
}
