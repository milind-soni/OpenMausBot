import { useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from "react";
import { ChevronDown, Columns3, Download, Loader2, MessageSquarePlus, Pencil, Pin, PinOff, Trash2, X } from "lucide-react";
import { DATA_ROUTES, type DataCard as DataCardModel, type DataColumn, type DataExportFormat, type DataExportRequest, type DataReduction } from "../../../shared/data-surface";
import { api, useStore, type Bot } from "@/state/store";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { cn } from "@/lib/cn";
import { copyText } from "@/lib/copy-text";
import { appendComposerDraft } from "@/lib/drafts";
import type { ColorScheme } from "@/lib/color-scheme";
import { ChatMarkdown } from "../ChatMarkdown";
import { DataGrid, type DataGridHandle } from "./DataGrid";
import { DataChart } from "./DataChart";
import { cardResultTable, formatCount, markdownTable } from "./data-format";

export interface DataCardProps {
  bot: Bot;
  card: DataCardModel;
  theme: ColorScheme;
  /** Open the column explorer on this card's result. */
  onExplore: (table: string, title: string) => void;
  /** Put this card's SQL into the editor; the next run updates the card. */
  onEdit: (card: DataCardModel) => void;
}

/** How the server shrank the rows before charting, in the person's words. */
const REDUCTION_KEYS: Record<DataReduction["method"], LocaleKey> = {
  group: "data.card.reduction.group", bins: "data.card.reduction.bins", topN: "data.card.reduction.topN",
  timeBucket: "data.card.reduction.timeBucket", m4: "data.card.reduction.m4", sample: "data.card.reduction.sample", none: "data.card.reduction.none",
};
const action = "flex items-center gap-1 rounded-md px-2 py-1 text-[11.5px] text-ink-secondary hover:bg-inset hover:text-ink disabled:cursor-not-allowed disabled:opacity-40";
const menuItem = "rounded-md px-3 py-1.5 text-left text-[12px] hover:bg-inset disabled:opacity-40";

/** The frame every card and the source view share: title row, body, footer. */
export function CardFrame({ title, status, body, footer, testId }: { title: ReactNode; status?: ReactNode; body: ReactNode; footer: ReactNode; testId?: string }) {
  return (
    <article className="flex flex-col overflow-hidden rounded-2xl border border-hairline/50 bg-card text-ink" data-testid={testId}>
      <header className="flex items-center gap-2 px-3 py-2">
        <h3 className="min-w-0 flex-1 truncate text-[13px] font-medium">{title}</h3>
        {status}
      </header>
      <div className="min-w-0 px-3">{body}</div>
      <footer className="flex flex-wrap items-center gap-1 px-2 py-1.5">{footer}</footer>
    </article>
  );
}

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
      <summary className={cn(action, "list-none cursor-pointer [&::-webkit-details-marker]:hidden")} aria-label={t("data.card.export")}>
        {busy ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Download size={13} aria-hidden="true" />}{t("data.card.export")}<ChevronDown size={11} aria-hidden="true" />
      </summary>
      <div className="absolute bottom-full left-0 z-20 mb-1 flex w-52 flex-col rounded-xl border border-hairline/50 bg-menu p-1.5 shadow-xl">
        {formats.map((format) => (
          <button key={format} type="button" className={menuItem} disabled={busy} onClick={(event) => { close(event); onExport(format); }}>{labels[format]}</button>
        ))}
        {onCopyMarkdown && <button type="button" className={menuItem} onClick={(event) => { close(event); onCopyMarkdown(); }}>{t("data.card.copyMarkdown")}</button>}
      </div>
    </details>
  );
}

/** One card of the sheet: its title, its body (grid, chart or text), and
 * the footer with the SQL behind it, export, "Ask to change", pin and
 * remove. Running shows a spinner and Cancel; failed shows DuckDB's own
 * message with the SQL open. */
export function DataCard({ bot, card, theme, onExplore, onEdit }: DataCardProps) {
  const { dispatch } = useStore();
  const grid = useRef<DataGridHandle | null>(null);
  // One identity per card: the grid's paging keys off it.
  const target = useMemo(() => ({ cardId: card.id }), [card.id]);
  const exporter = useExportMenu(bot.id, target, grid);
  const resultTable = cardResultTable(card);
  const columns: DataColumn[] = card.columns ?? [];
  const askToChange = () => appendComposerDraft(`bot:${bot.id}:${bot.threadId}`, t("data.card.askToChangeText", { id: card.id }));
  const reduction = card.reduction && card.reduction.method !== "none"
    ? t("data.card.reduction", { output: formatCount(card.reduction.outputRows), input: formatCount(card.reduction.inputRows), method: t(REDUCTION_KEYS[card.reduction.method]) })
    : null;

  const status = card.status === "running"
    ? <span className="flex items-center gap-2 text-[11.5px] text-ink-secondary" role="status">
        <Loader2 size={13} className="animate-spin" aria-hidden="true" />{t("data.card.running")}
        <button type="button" onClick={() => dispatch({ type: "cancelDataCard", botId: bot.id, cardId: card.id })} className="rounded-md border border-hairline/60 px-2 py-0.5 text-ink hover:bg-inset">{t("data.card.cancel")}</button>
      </span>
    : <span className="flex items-center gap-2 text-[11px] text-ink-tertiary">
        {card.status === "ready" && typeof card.rowCount === "number" && card.kind !== "text" && (
          <span>{t(card.truncated ? "data.card.rowsTruncated" : "data.card.rows", { count: formatCount(card.rowCount) })}</span>
        )}
        {typeof card.elapsedMs === "number" && <span>{t("data.card.elapsed", { ms: formatCount(Math.round(card.elapsedMs)) })}</span>}
        {card.pinned && <Pin size={11} aria-label={t("data.card.pin")} />}
      </span>;

  const body = card.status === "running"
    ? <div className="flex min-h-24 items-center justify-center text-[12px] text-ink-secondary"><Loader2 size={18} className="animate-spin" aria-hidden="true" /></div>
    : card.status === "failed"
      ? <div role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger" data-testid="card-error">
          <div className="font-medium">{t("data.card.failed")}{card.error?.line ? ` · ${t("data.card.line", { line: card.error.line })}` : ""}</div>
          <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11.5px]">{card.error?.message}</pre>
          {card.error?.hint && <p className="mt-1 text-ink-secondary">{card.error.hint}</p>}
        </div>
      : card.kind === "chart" && card.vegaLite
        ? <>
            <DataChart botId={bot.id} cardId={card.id} spec={card.vegaLite} rowCount={card.rowCount} theme={theme} />
            {reduction && <p className="mt-1 text-[11px] text-ink-tertiary">{reduction}</p>}
          </>
        : card.kind === "text"
          ? <div className="chat-md text-[13px]"><ChatMarkdown text={card.text ?? ""} /></div>
          : <DataGrid botId={bot.id} target={target} columns={columns} rowCount={card.rowCount ?? 0} name={card.title} handle={grid} />;

  const footer = <>
    {card.sql && (
      <details className="w-full" open={card.status === "failed" || undefined} data-testid="card-sql">
        <summary className={cn(action, "inline-flex list-none cursor-pointer [&::-webkit-details-marker]:hidden")}>
          <ChevronDown size={11} aria-hidden="true" />{t("data.card.sql")}
        </summary>
        <div className="relative mx-1 mb-1 mt-1 rounded-xl bg-inset">
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11.5px] leading-5 text-ink">{card.sql}</pre>
          <button type="button" onClick={() => onEdit(card)} className={cn(action, "absolute right-1 top-1 bg-card/80")} aria-label={t("data.card.edit")}><Pencil size={12} aria-hidden="true" />{t("data.card.edit")}</button>
        </div>
      </details>
    )}
    <div className="flex w-full flex-wrap items-center gap-1">
      {resultTable && card.status === "ready" && card.kind !== "text" && (
        <button type="button" className={action} onClick={() => onExplore(resultTable, card.title)}><Columns3 size={13} aria-hidden="true" />{t("data.card.columns")}</button>
      )}
      {card.status === "ready" && card.kind !== "text" && (
        <ExportMenu busy={exporter.busy} onExport={(format) => void exporter.exportAs(format)}
          formats={card.kind === "chart" ? ["png", "svg", "csv"] : ["csv", "parquet", "xlsx"]}
          onCopyMarkdown={card.kind === "table" ? () => void exporter.copyMarkdown() : undefined} />
      )}
      <button type="button" className={action} onClick={askToChange}><MessageSquarePlus size={13} aria-hidden="true" />{t("data.card.askToChange")}</button>
      <span className="ml-auto flex items-center gap-1">
        {exporter.notice && <span role={exporter.notice.kind} className={cn("max-w-64 truncate text-[11px]", exporter.notice.kind === "alert" ? "text-danger" : "text-ink-secondary")} title={exporter.notice.text}>{exporter.notice.text}</span>}
        <button type="button" className={action} aria-label={t(card.pinned ? "data.card.unpin" : "data.card.pin")} title={t(card.pinned ? "data.card.unpin" : "data.card.pin")}
          onClick={() => dispatch({ type: "patchDataCard", botId: bot.id, cardId: card.id, patch: { pinned: !card.pinned } })}>
          {card.pinned ? <PinOff size={13} /> : <Pin size={13} />}
        </button>
        <button type="button" className={action} aria-label={t("data.card.delete")} title={t("data.card.delete")}
          onClick={() => dispatch({ type: "deleteDataCard", botId: bot.id, cardId: card.id })}><Trash2 size={13} /></button>
      </span>
    </div>
  </>;

  return <CardFrame testId={`data-card-${card.kind}`} title={card.title} status={status} body={body} footer={footer} />;
}

/** A loaded table opened from the Sources strip: the same grid, without a
 * card on the sheet. Closing it forgets nothing; the table stays loaded. */
export function SourceView({ bot, name, columns, rowCount, onClose }: { bot: Bot; name: string; columns: DataColumn[]; rowCount: number; onClose: () => void }) {
  const grid = useRef<DataGridHandle | null>(null);
  const target = useMemo(() => ({ table: name }), [name]);
  const exporter = useExportMenu(bot.id, target, grid);
  return <CardFrame testId="data-source-view" title={name}
    status={<button type="button" onClick={onClose} aria-label={t("data.source.close")} className="rounded-md p-1 text-ink-secondary hover:bg-inset hover:text-ink"><X size={14} /></button>}
    body={<DataGrid botId={bot.id} target={target} columns={columns} rowCount={rowCount} name={name} handle={grid} />}
    footer={<>
      <ExportMenu busy={exporter.busy} formats={["csv", "parquet", "xlsx"]} onExport={(format) => void exporter.exportAs(format)} onCopyMarkdown={() => void exporter.copyMarkdown()} />
      {exporter.notice && <span role={exporter.notice.kind} className={cn("ml-auto max-w-64 truncate text-[11px]", exporter.notice.kind === "alert" ? "text-danger" : "text-ink-secondary")}>{exporter.notice.text}</span>}
    </>} />;
}
