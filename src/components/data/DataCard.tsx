import { useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from "react";
import { ChevronDown, Download, Loader2 } from "lucide-react";
import { DATA_ROUTES, type DataCard as DataCardModel, type DataColumn, type DataExportFormat, type DataExportRequest, type DataReduction } from "../../../shared/data-surface";
import { api, type Bot } from "@/state/store";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { cn } from "@/lib/cn";
import { copyText } from "@/lib/copy-text";
import type { ColorScheme } from "@/lib/color-scheme";
import { ChatMarkdown } from "../ChatMarkdown";
import { DataGrid, DataResultFooter, type DataGridHandle } from "./DataGrid";
import { DataChart } from "./DataChart";
import { formatCount, markdownTable } from "./data-format";

export interface DataCardProps {
  bot: Bot;
  card: DataCardModel;
  theme: ColorScheme;
  controls?: ReactNode;
  /** The panel's own run of this card's SQL is on the wire; the card itself stays "ready". */
  running?: boolean;
  onCancel: () => void;
}

/** The one spinner-and-Cancel for a card's first run and for a live edit. */
export function RunningStatus({ onCancel }: { onCancel: () => void }) {
  return <span className="flex items-center gap-2 text-[11.5px] text-ink-secondary" role="status">
    <Loader2 size={13} className="animate-spin" aria-hidden="true" />{t("data.card.running")}
    <button type="button" onClick={onCancel} className="rounded-md border border-hairline/60 px-2 py-0.5 text-ink hover:bg-inset">{t("data.card.cancel")}</button>
  </span>;
}

/** How the server shrank the rows before charting, in the person's words. */
const REDUCTION_KEYS: Record<DataReduction["method"], LocaleKey> = {
  group: "data.card.reduction.group", bins: "data.card.reduction.bins", topN: "data.card.reduction.topN",
  timeBucket: "data.card.reduction.timeBucket", m4: "data.card.reduction.m4", sample: "data.card.reduction.sample", none: "data.card.reduction.none",
};
const action = "flex items-center gap-1 rounded-md px-2 py-1 text-[11.5px] text-ink-secondary hover:bg-inset hover:text-ink disabled:cursor-not-allowed disabled:opacity-40";
const menuItem = "rounded-md px-3 py-1.5 text-left text-[12px] hover:bg-inset disabled:opacity-40";

/** Export and copy for any paged result: a card's or a loaded table's. The
 * server writes the file and answers with where it put it. */
export function useExportMenu(botId: string, target: Omit<DataExportRequest, "format">, grid: RefObject<DataGridHandle | null>) {
  const [notice, setNotice] = useState<{ kind: "status" | "alert"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const say = (kind: "status" | "alert", text: string) => {
    setNotice({ kind, text });
    setTimeout(() => setNotice((current) => current?.text === text ? null : current), kind === "status" ? 4000 : 8000);
  };
  const exportAs = async (format: DataExportFormat) => {
    setBusy(true);
    try {
      const result = await api<{ path?: string }>(DATA_ROUTES.export(botId), { method: "POST", body: JSON.stringify({ ...target, format }) });
      if (result?.path) say("status", t("data.card.exported", { path: result.path }));
    } catch (cause) {
      say("alert", t("data.card.exportFailed", { reason: cause instanceof Error ? cause.message : String(cause) }));
    } finally {
      setBusy(false);
    }
  };
  const copyMarkdown = async () => {
    const page = grid.current?.visibleRows();
    if (!page || page.rows.length === 0) return;
    const result = await copyText(markdownTable(page.columns, page.rows));
    if (result !== "empty") say(result === "copied" ? "status" : "alert", t(result === "copied" ? "data.card.copied" : "data.card.copyFailed"));
  };
  return { notice, busy, exportAs, copyMarkdown };
}

export function ExportMenu({ formats, busy, onExport, onCopyMarkdown }: { formats: DataExportFormat[]; busy: boolean; onExport: (format: DataExportFormat) => void; onCopyMarkdown?: () => void }) {
  const labels: Record<DataExportFormat, string> = {
    csv: t("data.card.exportCsv"), parquet: t("data.card.exportParquet"), xlsx: t("data.card.exportXlsx"), png: t("data.card.exportPng"), svg: "SVG",
  };
  const close = (event: ReactMouseEvent<HTMLElement>) => event.currentTarget.closest("details")?.removeAttribute("open");
  return (
    <details className="relative">
      <summary role="button" className={cn(action, "list-none cursor-pointer [&::-webkit-details-marker]:hidden")} aria-label={t("data.card.export")} title={t("data.card.export")}>
        {busy ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Download size={13} aria-hidden="true" />}<span className="hidden @min-[460px]/data:inline">{t("data.card.export")}</span><ChevronDown size={11} aria-hidden="true" />
      </summary>
      <div className="absolute right-0 bottom-full z-20 mb-1 flex max-h-[min(20rem,calc(100cqh-3rem))] w-52 flex-col overflow-y-auto rounded-xl border border-hairline/50 bg-menu p-1.5 shadow-xl">
        {formats.map((format) => (
          <button key={format} type="button" className={menuItem} disabled={busy} onClick={(event) => { close(event); onExport(format); }}>{labels[format]}</button>
        ))}
        {onCopyMarkdown && <button type="button" className={menuItem} onClick={(event) => { close(event); onCopyMarkdown(); }}>{t("data.card.copyMarkdown")}</button>}
      </div>
    </details>
  );
}

/** The one selected result, with only display and export controls. */
export function DataCard({ bot, card, theme, controls, running, onCancel }: DataCardProps) {
  const grid = useRef<DataGridHandle | null>(null);
  const [view, setView] = useState<"chart" | "table">("chart");
  // One identity per card: the grid's paging keys off it.
  const target = useMemo(() => ({ cardId: card.id }), [card.id]);
  const exporter = useExportMenu(bot.id, target, grid);
  const columns: DataColumn[] = card.columns ?? [];
  const reduction = card.reduction && card.reduction.method !== "none"
    ? t("data.card.reduction", { output: formatCount(card.reduction.outputRows), input: formatCount(card.reduction.inputRows), method: t(REDUCTION_KEYS[card.reduction.method]) })
    : null;

  const status = card.status === "ready" && typeof card.rowCount === "number"
    ? <span role="status">{t(card.truncated ? "data.card.rowsTruncated" : "data.grid.count", { count: formatCount(card.rowCount), columns: columns.length })}</span>
    : null;

  const actions = <>
    {(card.status === "running" || running) && <RunningStatus onCancel={onCancel} />}
    {card.status === "ready" && card.kind === "chart" && card.vegaLite && (
      <div className="flex items-center rounded-lg border border-hairline/50 p-0.5">
        {(["chart", "table"] as const).map((mode) => (
          <button key={mode} type="button" className={cn(action, view === mode && "bg-inset text-ink")} aria-pressed={view === mode} onClick={() => setView(mode)}>{t(`data.view.${mode}`)}</button>
        ))}
      </div>
    )}
    {card.status === "ready" && card.kind !== "text" && (
      <ExportMenu busy={exporter.busy} onExport={(format) => void exporter.exportAs(format)}
        formats={card.kind === "chart" ? ["png", "svg", "csv"] : ["csv", "parquet", "xlsx"]}
        onCopyMarkdown={card.kind === "table" || view === "table" ? () => void exporter.copyMarkdown() : undefined} />
    )}
    {exporter.notice && <span role={exporter.notice.kind} className={cn("absolute inset-x-0 bottom-full z-10 truncate border-t border-hairline/40 bg-card px-3 py-1 text-[11px]", exporter.notice.kind === "alert" ? "text-danger" : "text-ink-secondary")} title={exporter.notice.text}>{exporter.notice.text}</span>}
    {controls}
  </>;

  const table = card.status === "ready" && card.kind !== "text" && !(card.kind === "chart" && card.vegaLite && view === "chart");
  const body = card.status === "running"
    ? <div className="flex min-h-0 flex-1 items-center justify-center text-[12px] text-ink-secondary"><Loader2 size={18} className="animate-spin" aria-hidden="true" /></div>
    : card.status === "failed"
      ? <div role="alert" className="min-h-0 flex-1 overflow-auto px-3 py-2 text-[12px] text-danger" data-testid="card-error">
          <div className="font-medium">{t("data.card.failed")}{card.error?.line ? ` · ${t("data.card.line", { line: card.error.line })}` : ""}</div>
          <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11.5px]">{card.error?.message}</pre>
          {card.error?.hint && <p className="mt-1 text-ink-secondary">{card.error.hint}</p>}
        </div>
      : card.kind === "chart" && card.vegaLite && view === "chart"
        ? <div className="min-h-0 flex-1 overflow-auto" data-testid="data-chart-viewport"><div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col p-3">
            <DataChart botId={bot.id} cardId={card.id} spec={card.vegaLite} rowCount={card.rowCount} theme={theme} revision={card.result ?? card.updatedAt} />
            {reduction && <p className="mt-1 shrink-0 text-[11px] text-ink-tertiary">{reduction}</p>}
          </div></div>
        : card.kind === "text"
          ? <div className="chat-md min-h-0 flex-1 overflow-auto px-3 py-2 text-[13px]"><ChatMarkdown text={card.text ?? ""} /></div>
          : <DataGrid botId={bot.id} target={target} columns={columns} rowCount={card.rowCount ?? 0} name={card.title} revision={card.result ?? card.updatedAt} handle={grid} footerControls={actions} />;

  return <article className="flex min-h-0 min-w-0 flex-1 flex-col text-ink" data-testid={`data-card-${card.kind}`} data-card-id={card.id} aria-label={card.title}>
    {body}
    {!table && <DataResultFooter controls={actions}>{status}</DataResultFooter>}
  </article>;
}
