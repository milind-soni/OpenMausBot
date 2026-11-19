import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, Check, Copy, Download, Search, WrapText } from "lucide-react";
import { isTableAmount, tableCsv, tableRowOrder, type TableSort } from "@/lib/table-data";
import { intlLocale, t } from "@/lib/i18n";
import { copyText } from "@/lib/copy-text";
import { columnMinimums, fitsColumns } from "@/lib/table-fit";
import { cn } from "@/lib/cn";


export interface TableCell { text: string; content?: ReactNode; align?: TableAlign; vAlign?: "top" | "middle" | "bottom" }
export type TableAlign = "left" | "center" | "right" | "start" | "end";
export interface TableColumn extends TableCell { width?: number }
export interface RichTableProps {
  columns: TableColumn[];
  rows: TableCell[][];
  name?: string;
  filePreview?: boolean;
  direction?: "rtl" | "ltr";
  headless?: boolean;
}

export function RichTable({ columns, rows, name = t("table.title"), filePreview = false, direction = "ltr", headless = false }: RichTableProps) {

  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [sort, setSort] = useState<TableSort>(null);
  const [wrap, setWrap] = useState(true);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const values = useMemo(() => rows.map((row) => row.map((cell) => cell.text)), [rows]);
  const order = useMemo(() => tableRowOrder(values, deferredQuery, sort), [values, deferredQuery, sort]);
  useEffect(() => {
    if (copyState === "idle") return;
    const timer = setTimeout(() => setCopyState("idle"), 2500);
    return () => clearTimeout(timer);
  }, [copyState]);
  const csv = () => tableCsv(columns.map((column) => column.text), order.map((index) => values[index]!));
  const copy = async () => {
    const result = await copyText(csv());
    if (result !== "empty") setCopyState(result);
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob(["\uFEFF", csv()], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${name.replace(/\.(csv|tsv)$/i, "").replace(/[\\/:*?"<>|]/g, "_").slice(0, 150) || "table"}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const search = (className: string) => (
    <label className={className}>
      <Search size={13} aria-hidden="true" />
      <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t("table.search")}
        placeholder={t("table.search")} className="w-full min-w-0 bg-transparent py-1 text-xs text-ink outline-none placeholder:text-ink-tertiary focus:bg-raised/50" />
    </label>
  );
  const sortBy = (column: number) => setSort(sort?.column !== column ? { column, descending: false } : !sort.descending ? { column, descending: true } : null);
  return <div className="chat-table">
    <div className={cn("rich-table w-fit min-w-[min(100%,var(--chat-prose-max))] max-w-full overflow-hidden rounded-xl border border-hairline/50 text-ink", "bg-panel")} dir="ltr">
      <div className="flex flex-wrap items-center gap-1 border-b border-hairline/40 px-2 py-1.5">
        {search("flex min-w-24 flex-1 items-center gap-2 px-1 text-ink-secondary")}
        <button type="button" className="table-action" aria-label={t("table.wrap")} title={t("table.wrap")} aria-pressed={wrap} onClick={() => setWrap(!wrap)}><WrapText size={14} /></button>
        <button type="button" className="table-action" aria-label={t("table.copy")} title={t("table.copy")} onClick={() => void copy()}>{copyState === "copied" ? <Check size={14} /> : <Copy size={14} />}</button>
        <button type="button" className="table-action" aria-label={t("table.download")} title={t("table.download")} onClick={download}><Download size={14} /></button>
      </div>
      <TableViewport columns={columns} rows={rows} order={order} name={name} wrap={wrap} large={filePreview} sort={sort} direction={direction} headless={headless} onSort={sortBy} />
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline/40 px-3 py-2 text-[11px] text-ink-secondary">
        <span role="status">{t("table.count", { shown: order.length.toLocaleString(intlLocale()), total: rows.length.toLocaleString(intlLocale()), columns: columns.length })}</span>
        {copyState !== "idle" && <span role={copyState === "failed" ? "alert" : "status"}>{t(copyState === "failed" ? "table.copyFailed" : "table.copied")}</span>}
      </footer>
    </div>
  </div>;
}

function TableViewport({ columns, rows, order, name, wrap, large, sort, onSort, direction, headless = false }: RichTableProps & {
  order: number[]; wrap: boolean; large: boolean; sort: TableSort; onSort: (column: number) => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLTableSectionElement>(null);
  const [headingHeight, setHeadingHeight] = useState(40);
  useEffect(() => {
    if (!heading.current) return;
    const observer = new ResizeObserver(([entry]) => { if (entry) setHeadingHeight(entry.target.getBoundingClientRect().height); });
    observer.observe(heading.current);
    return () => observer.disconnect();
  }, []);
  const virtual = order.length > 80;
  const minimums = useMemo(() => columnMinimums(columns.map((column) => column.text), rows.map((row) => row.map((cell) => cell.text))), [columns, rows]);
  const [available, setAvailable] = useState<number | null>(null);
  useEffect(() => {
    const element = scroll.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setAvailable(element.clientWidth || null));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const fit = fitsColumns({ wrap, virtual, minimums, available });
  const widths = useMemo(() => columns.map((column, index) => column.width ?? Math.min(320, Math.max(140,
    Math.max(column.text.length, ...rows.slice(0, 100).map((row) => Math.min(40, row[index]?.text.length ?? 0))) * 7 + 40,
  ))), [columns, rows]);
  const numeric = useMemo(() => columns.map((_, index) => {
    const nonempty = rows.slice(0, 200).map((row) => row[index]?.text.trim() ?? "").filter(Boolean);
    return nonempty.length > 0 && nonempty.every(isTableAmount);
  }), [columns, rows]);
  const virtualizer = useVirtualizer({ count: order.length, getScrollElement: () => scroll.current, estimateSize: () => 42,
    getItemKey: (index) => order[index]!, overscan: 6, enabled: virtual, initialRect: { width: 800, height: 400 }, scrollMargin: headingHeight });
  useEffect(() => { if (scroll.current) scroll.current.scrollTop = 0; }, [order]);
  useEffect(() => { virtualizer.measure(); }, [wrap, widths, virtualizer]);
  const items = virtual ? virtualizer.getVirtualItems() : order.map((id, index) => ({ key: id, index, start: 0, end: 0 }));
  const before = virtual && items.length ? Math.max(0, items[0]!.start - headingHeight) : 0;
  const after = virtual && items.length ? Math.max(0, virtualizer.getTotalSize() - items.at(-1)!.end + headingHeight) : 0;
  const alignment = (column: TableColumn, index: number) => column.align ?? (numeric[index] || direction === "rtl" ? "right" : "left");
  const sortLabel = (column: TableColumn, index: number) => t("table.sort", { column: column.text || index + 1 });
  const header = (column: TableColumn, index: number) => column.content ?? (column.text || t("table.column", { number: index + 1 }));
  const arrow = (index: number, className?: string) => sort?.column === index && sort.descending ? <ArrowDown size={12} className={className} /> : <ArrowUp size={12} className={cn(className, sort?.column !== index && "opacity-35")} />;
  return <div ref={scroll} tabIndex={0} role="region" aria-label={name}
    className={cn("overflow-auto overscroll-x-contain focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60")}
    style={{ maxHeight: large ? "65dvh" : virtual || !wrap ? 400 : undefined }} data-fit={fit || undefined}>
    <table dir={direction} aria-label={name} aria-rowcount={order.length + 1} className={cn("w-full border-separate border-spacing-0 text-[14px]", fit ? "table-auto" : "table-fixed")} style={fit ? undefined : { minWidth: widths.reduce((a, b) => a + b, 0) }}>
      {!fit && <colgroup>{widths.map((width, index) => <col key={index} style={{ width }} />)}</colgroup>}
      <thead ref={heading} hidden={headless} className="sticky top-0 z-10 bg-raised"><tr aria-rowindex={1}>
        {columns.map((column, index) => <th key={index} scope="col" aria-sort={sort?.column === index ? sort.descending ? "descending" : "ascending" : "none"}
          className={"h-10 border-b border-hairline/60 px-3 py-2 font-medium"} style={{ textAlign: alignment(column, index) }}>
          <div className="inline-flex max-w-full items-center gap-1 whitespace-nowrap" style={fit ? { minWidth: minimums[index] } : undefined}>
            <span dir="auto" className="min-w-0 truncate" title={column.text}>{header(column, index)}</span>
            <button type="button" className="inline-flex shrink-0 rounded hover:bg-inset focus-visible:outline-accent" aria-label={sortLabel(column, index)} title={sortLabel(column, index)} onClick={() => onSort(index)}>{arrow(index)}</button>
          </div>
        </th>)}
      </tr></thead>
      <tbody>
        {before > 0 && <tr aria-hidden="true"><td colSpan={columns.length} style={{ height: before, padding: 0 }} /></tr>}
        {items.map((item) => <tr key={item.key} data-index={item.index} ref={virtual ? virtualizer.measureElement : undefined} aria-rowindex={item.index + 2}
          className={item.index % 2 ? "bg-inset/35 hover:bg-raised/70" : "hover:bg-raised/70"}>
          {columns.map((column, index) => {
            const cell = rows[order[item.index]!]![index];
            return <td key={index} className={"border-b border-hairline/20 px-3 py-2.5 align-top tabular-nums"} style={{ textAlign: cell?.align ?? alignment(column, index), verticalAlign: cell?.vAlign }}>
              <div dir="auto" title={!wrap ? cell?.text : undefined} className={wrap ? "whitespace-pre-wrap break-words [overflow-wrap:anywhere]" : "truncate"}>{cell?.content ?? cell?.text}</div>
            </td>;
          })}
        </tr>)}
        {after > 0 && <tr aria-hidden="true"><td colSpan={columns.length} style={{ height: after, padding: 0 }} /></tr>}
      </tbody>
    </table>
    {order.length === 0 && <p className="p-8 text-center text-sm text-ink-secondary">{t(rows.length ? "table.noResults" : "table.empty")}</p>}
  </div>;
}
