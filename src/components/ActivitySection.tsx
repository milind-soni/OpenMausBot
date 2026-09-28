// App settings → Activity, for admins on a workspace served to a browser:
// who changed settings, people, sessions, webhooks, MCP servers, engines,
// bots, budgets and bot visibility, beside who answered approval cards —
// filtered by who, what and when, and exported as CSV. Read-only: the log is
// GET /api/admin-activity (server/admin-activity.ts), kept on this server.
import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Download, Loader2, RefreshCw } from "lucide-react";

import { api } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { ACTIVITY_WHATS, activityQuery, describeEntry, formatValue, whoLabel, type ActivityEntry, type ActivityFilters, type ActivityWhat } from "@/lib/activity";
import type { LocaleKey } from "@/locales";
import { Card } from "./SettingsPrimitives";

const inputClass = "rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none [color-scheme:dark]";

/** One row: when, who, what happened; a changed setting opens to its values. */
export function ActivityRow({ entry }: { entry: ActivityEntry }) {
  const [open, setOpen] = useState(false);
  const detail = entry.type === "admin" && (entry.changed?.length || entry.before || entry.after);
  return (
    <li className="border-b border-hairline/20 py-2 text-[13px]" data-activity-entry={entry.type}>
      <div className="grid grid-cols-[auto_1fr] items-start gap-x-3">
        <time className="whitespace-nowrap tabular-nums text-ink-secondary" dateTime={entry.at}>{new Date(entry.at).toLocaleString()}</time>
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium text-ink">{whoLabel(entry.who)}</span>
            <span className="min-w-0 break-words text-ink">{describeEntry(entry)}</span>
          </div>
          {entry.type === "approval" && entry.summary && <div className="mt-0.5 truncate text-[12px] text-ink-secondary">{entry.summary}</div>}
          {detail && (
            <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="mt-0.5 flex items-center gap-1 text-[12px] text-ink-secondary hover:text-ink">
              <ChevronRight size={12} className={cn("transition-transform", open && "rotate-90")} />
              {t("activity.changed", { paths: (entry.changed ?? []).join(", ") || "—" })}
            </button>
          )}
          {detail && open && entry.type === "admin" && (
            <dl className="mt-1 grid grid-cols-[auto_1fr_1fr] gap-x-3 gap-y-0.5 rounded-lg bg-inset p-2 text-[12px]">
              <dt />
              <dd className="text-ink-secondary">{t("activity.before")}</dd>
              <dd className="text-ink-secondary">{t("activity.after")}</dd>
              {(entry.changed ?? Object.keys({ ...entry.before, ...entry.after })).map((path) => (
                <div key={path} className="contents">
                  <dt className="font-mono text-ink-secondary">{path}</dt>
                  <dd className="min-w-0 break-all font-mono text-ink">{formatValue(entry.before?.[path])}</dd>
                  <dd className="min-w-0 break-all font-mono text-ink">{formatValue(entry.after?.[path])}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </div>
    </li>
  );
}

export function ActivitySection() {
  const [filters, setFilters] = useState<ActivityFilters>({ who: "", what: "all", from: "", to: "" });
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [days, setDays] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = activityQuery(filters);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const body = await api(`/api/admin-activity${query}`) as { entries: ActivityEntry[]; total: number; retentionDays: number };
      setEntries(body.entries);
      setTotal(body.total);
      setDays(body.retentionDays);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [query]);

  // Typing in "who" should not fire a request per key.
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 250);
    return () => window.clearTimeout(timer);
  }, [load]);

  const set = (patch: Partial<ActivityFilters>) => setFilters((current) => ({ ...current, ...patch }));
  return (
    <Card title={t("activity.title")} subtitle={t("activity.subtitle", { days: String(days ?? 180) })}>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-[12px] text-ink-secondary">
          {t("activity.who")}
          <input value={filters.who} onChange={(e) => set({ who: e.target.value })} placeholder={t("activity.whoPlaceholder")} className={cn(inputClass, "w-44")} />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-ink-secondary">
          {t("activity.what")}
          <select value={filters.what} onChange={(e) => set({ what: e.target.value as ActivityWhat })} className={inputClass}>
            {ACTIVITY_WHATS.map((what) => <option key={what} value={what}>{t(`activity.what.${what}` as LocaleKey)}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-ink-secondary">
          {t("activity.from")}
          <input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => set({ from: e.target.value })} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-ink-secondary">
          {t("activity.to")}
          <input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => set({ to: e.target.value })} className={inputClass} />
        </label>
        <button type="button" onClick={() => void load()} disabled={loading} aria-label={t("activity.refresh")} title={t("activity.refresh")} className="rounded-md p-2 text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50">
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        </button>
        <a href={`/api/admin-activity.csv${query}`} download className="flex items-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[12.5px] font-medium text-ink hover:bg-control/70">
          <Download size={13} aria-hidden="true" />{t("activity.export")}
        </a>
      </div>
      {error && <p role="alert" className="mt-3 text-[12.5px] text-danger">{t("activity.error", { message: error })}</p>}
      {!error && entries.length === 0 && !loading && <p className="mt-4 text-[13px] text-ink-secondary">{t("activity.empty")}</p>}
      {entries.length > 0 && (
        <ul className="mt-3 flex flex-col">
          {entries.map((entry, index) => <ActivityRow key={`${entry.at}-${index}`} entry={entry} />)}
        </ul>
      )}
      {total > entries.length && <p className="mt-3 text-[12px] text-ink-secondary">{t("activity.more", { shown: String(entries.length), total: String(total) })}</p>}
    </Card>
  );
}
