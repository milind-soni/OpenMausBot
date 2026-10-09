import { useEffect, useState } from "react";
import { ChevronDown, Loader2, X } from "lucide-react";
import { DATA_ROUTES, type DataColumn, type DataColumnStats, type DataHistogram } from "../../../shared/data-surface";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { formatCount, isNumericType, isTemporalType } from "./data-format";

export interface ColumnExplorerProps {
  botId: string;
  /** The table as SQL names it: a loaded table, or omb_results.q_n for a card. */
  table: string;
  title: string;
  onClose: () => void;
}

type Bins = DataHistogram["bins"];

/** The right-hand drawer: every column's type, null share, distinct count
 * and range from one stats call, and its distribution (20 bins, or the top
 * values of a text column) fetched when a column is opened and kept by
 * (table, column, rowCount), so reopening costs nothing. */
export function ColumnExplorer({ botId, table, title, onClose }: ColumnExplorerProps) {
  const [stats, setStats] = useState<DataColumnStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [histograms, setHistograms] = useState<Record<string, { bins?: Bins; error?: string }>>({});
  useEffect(() => {
    let alive = true;
    setStats(null); setError(null); setOpen(null); setHistograms({});
    api<DataColumnStats>(DATA_ROUTES.stats(botId, table))
      .then((result) => { if (alive) setStats(result); })
      .catch((cause) => { if (alive) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { alive = false; };
  }, [botId, table]);
  const histogramKey = (column: string) => `${table}:${column}:${stats?.rowCount ?? 0}`;
  const toggle = (column: DataColumn) => {
    const next = open === column.name ? null : column.name;
    setOpen(next);
    if (!next || histograms[histogramKey(next)]) return;
    const key = histogramKey(next);
    api<DataHistogram>(DATA_ROUTES.histogram(botId, table, next))
      .then((result) => setHistograms((current) => ({ ...current, [key]: { bins: result.bins } })))
      .catch((cause) => setHistograms((current) => ({ ...current, [key]: { error: cause instanceof Error ? cause.message : String(cause) } })));
  };
  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-hairline/40 bg-panel text-ink" aria-label={t("data.explorer.title", { table: title })} data-testid="column-explorer">
      <div className="flex items-center gap-2 border-b border-hairline/40 px-3 py-2">
        <h3 className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{t("data.explorer.title", { table: title })}</h3>
        {stats && <span className="text-[11px] text-ink-secondary">{t("data.sources.rows", { count: formatCount(stats.rowCount) })}</span>}
        <button type="button" onClick={onClose} aria-label={t("data.explorer.close")} className="rounded-md p-1 text-ink-secondary hover:bg-inset hover:text-ink"><X size={14} /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!stats && !error && (
          <p className="flex items-center gap-2 px-3 py-4 text-[12px] text-ink-secondary" role="status"><Loader2 size={13} className="animate-spin" aria-hidden="true" />{t("data.explorer.loading")}</p>
        )}
        {error && <p role="alert" className="px-3 py-4 text-[12px] text-danger">{t("data.explorer.failed", { reason: error })}</p>}
        {stats?.columns.map((column) => {
          const expanded = open === column.name;
          const histogram = histograms[histogramKey(column.name)];
          return (
            <div key={column.name} className="border-b border-hairline/20">
              <button type="button" onClick={() => toggle(column)} aria-expanded={expanded} aria-label={t("data.explorer.show", { column: column.name })}
                className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-inset/60">
                <ChevronDown size={13} className={cn("mt-0.5 shrink-0 text-ink-tertiary transition-transform", !expanded && "-rotate-90")} aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="min-w-0 truncate text-[12.5px] font-medium">{column.name}</span>
                    <span className="shrink-0 text-[10.5px] text-ink-tertiary">{column.type.toLowerCase()}</span>
                  </span>
                  <span className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-ink-secondary">
                    {typeof column.nullPct === "number" && <span>{t("data.explorer.nulls", { pct: Math.round(column.nullPct * 10) / 10 })}</span>}
                    {typeof column.approxUnique === "number" && <span>{t("data.explorer.distinct", { count: formatCount(column.approxUnique) })}</span>}
                  </span>
                  {(column.min != null || column.max != null) && (
                    <span className="mt-0.5 block truncate text-[11px] text-ink-secondary" title={t("data.explorer.range", { min: column.min ?? "", max: column.max ?? "" })}>
                      {t("data.explorer.range", { min: column.min ?? "", max: column.max ?? "" })}
                    </span>
                  )}
                </span>
              </button>
              {expanded && (
                <div className="px-3 pb-3 pl-8">
                  {!histogram && <p className="flex items-center gap-2 text-[11px] text-ink-secondary" role="status"><Loader2 size={12} className="animate-spin" aria-hidden="true" />{t("data.explorer.loading")}</p>}
                  {histogram?.error && <p role="alert" className="text-[11px] text-danger">{t("data.explorer.histogramFailed", { reason: histogram.error })}</p>}
                  {histogram?.bins && (isNumericType(column.type) || isTemporalType(column.type)
                    ? <Sparkline bins={histogram.bins} />
                    : <TopValues bins={histogram.bins} />)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

/** Equal-width bins as bars; the first and last labels mark the range. */
function Sparkline({ bins }: { bins: Bins }) {
  const max = Math.max(1, ...bins.map((bin) => bin.count));
  const width = 100;
  const barWidth = bins.length ? width / bins.length : width;
  return (
    <figure className="m-0">
      <figcaption className="sr-only">{t("data.explorer.distribution")}</figcaption>
      <svg viewBox={`0 0 ${width} 28`} className="h-10 w-full" role="img" aria-label={t("data.explorer.distribution")} preserveAspectRatio="none">
        {bins.map((bin, index) => {
          const height = (bin.count / max) * 26;
          return <rect key={index} x={index * barWidth + 0.3} y={28 - height} width={Math.max(0.4, barWidth - 0.6)} height={height} className="fill-accent/80"><title>{`${bin.label}: ${formatCount(bin.count)}`}</title></rect>;
        })}
      </svg>
      <div className="flex justify-between text-[10px] text-ink-tertiary">
        <span className="truncate">{bins[0]?.label}</span>
        <span className="truncate">{bins.at(-1)?.label}</span>
      </div>
    </figure>
  );
}

/** The commonest values of a text column, with a bar per share. */
function TopValues({ bins }: { bins: Bins }) {
  const max = Math.max(1, ...bins.map((bin) => bin.count));
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label={t("data.explorer.topValues")}>
      {bins.slice(0, 8).map((bin, index) => (
        <li key={index} className="text-[11px]">
          <div className="flex justify-between gap-2">
            <span className="min-w-0 truncate" title={bin.label}>{bin.label || <span className="text-ink-tertiary">{t("data.grid.null")}</span>}</span>
            <span className="shrink-0 tabular-nums text-ink-secondary">{formatCount(bin.count)}</span>
          </div>
          <div className="mt-0.5 h-1 rounded bg-inset"><div className="h-1 rounded bg-accent/80" style={{ width: `${(bin.count / max) * 100}%` }} /></div>
        </li>
      ))}
    </ul>
  );
}
