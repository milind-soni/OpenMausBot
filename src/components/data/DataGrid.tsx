import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, Check, Copy, Search } from "lucide-react";
import { DATA_LIMITS, DATA_ROUTES, type DataColumn, type DataPage, type DataPageRequest } from "../../../shared/data-surface";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { copyText } from "@/lib/copy-text";
import { cellText, defaultColumnWidth, formatCount, isNumericType, pagesCovering, pageWindow, tsv, type Cell } from "./data-format";

/** What the card reads off the grid without re-rendering for every scroll:
 * the rows currently on screen, for "Copy page as Markdown". */
export interface DataGridHandle {
  visibleRows(): { columns: string[]; rows: Cell[][] };
}

export interface DataGridProps {
  botId: string;
  /** A card's result table or a loaded table; the server pages either. */
  target: { cardId: string } | { table: string };
  columns: DataColumn[];
  /** The result's size as the sheet knows it; a filter narrows it server-side. */
  rowCount: number;
  name: string;
  handle?: RefObject<DataGridHandle | null>;
}

const ROW_HEIGHT = 32;
const HEADER_HEIGHT = 36;
const MAX_HEIGHT = 360;
const PAGE = DATA_LIMITS.pageSize;
const FILTER_DELAY_MS = 250;

type Sort = NonNullable<DataPageRequest["sort"]>;
interface Cache {
  /** sort + filter the pages belong to; a change starts an empty cache. */
  key: string;
  pages: Map<number, Cell[][]>;
  /** The server's count for this sort + filter; null until the first page lands. */
  total: number | null;
  error: string | null;
}

const emptyCache = (key: string): Cache => ({ key, pages: new Map(), total: null, error: null });
const cacheKey = (sort: Sort | undefined, filter: string) => JSON.stringify([sort ?? null, filter]);

/** A server-paged grid: rows live on the server and arrive in pageSize
 * windows around what is on screen. Sort and filter are sent with every
 * page, so the server orders and narrows; the cache belongs to one
 * (sort, filter) pair and starts over when either changes. */
export function DataGrid({ botId, target, columns, rowCount, name, handle }: DataGridProps) {
  const [sort, setSort] = useState<Sort | undefined>(undefined);
  const [filterText, setFilterText] = useState("");
  const [filter, setFilter] = useState("");
  const [widths, setWidths] = useState<number[]>(() => columns.map(defaultColumnWidth));
  const [selection, setSelection] = useState<{ anchor: number; focus: number } | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const key = cacheKey(sort, filter);
  const [cache, setCache] = useState<Cache>(() => emptyCache(key));
  const live = cache.key === key ? cache : emptyCache(key);
  const total = live.total ?? rowCount;
  const scroll = useRef<HTMLDivElement>(null);
  const inflight = useRef(new Set<string>());
  const liveRef = useRef(live);
  liveRef.current = live;

  useEffect(() => { setWidths(columns.map(defaultColumnWidth)); }, [columns]);
  // Typing filters after a short pause, not per keystroke: each filter is a
  // server query over the whole result.
  useEffect(() => {
    const timer = setTimeout(() => setFilter(filterText.trim()), FILTER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [filterText]);
  useEffect(() => {
    if (copyState === "idle") return;
    const timer = setTimeout(() => setCopyState("idle"), 1500);
    return () => clearTimeout(timer);
  }, [copyState]);
  // A new sort or filter: back to the top, selection gone, and no page of
  // the old order may land in the new cache (checked by key below).
  useEffect(() => {
    setSelection(null);
    if (scroll.current) scroll.current.scrollTop = 0;
  }, [key]);

  const load = useCallback(async (page: number) => {
    const requestKey = key;
    const mark = `${requestKey}:${page}`;
    if (inflight.current.has(mark) || liveRef.current.pages.has(page)) return;
    inflight.current.add(mark);
    const known = liveRef.current.total ?? rowCount;
    const body: DataPageRequest = { ...target, ...pageWindow(page, known), ...(sort ? { sort } : {}), ...(filter ? { filter } : {}) };
    try {
      const result = await api<DataPage>(DATA_ROUTES.page(botId), { method: "POST", body: JSON.stringify(body) });
      setCache((previous) => {
        if (previous.key !== requestKey) return previous;
        const pages = new Map(previous.pages);
        pages.set(page, result.rows);
        return { ...previous, pages, total: result.rowCount, error: null };
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setCache((previous) => previous.key !== requestKey ? previous : { ...previous, error: message });
    } finally {
      inflight.current.delete(mark);
    }
  }, [botId, target, key, sort, filter, rowCount]);

  const virtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => scroll.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    initialRect: { width: 800, height: MAX_HEIGHT },
    scrollMargin: HEADER_HEIGHT,
  });
  const items = virtualizer.getVirtualItems();
  const firstIndex = items[0]?.index ?? 0;
  const lastIndex = items.at(-1)?.index ?? Math.min(total - 1, 16);
  useEffect(() => {
    // The cache for this key starts empty; make sure it exists before pages
    // land, so a stale cache of another key is never read.
    setCache((previous) => previous.key === key ? previous : emptyCache(key));
    if (total <= 0 && live.total !== null) return;
    for (const page of pagesCovering(firstIndex, Math.max(firstIndex, lastIndex))) void load(page);
  }, [key, firstIndex, lastIndex, total, live.total, load]);

  const rowAt = (index: number): Cell[] | undefined => live.pages.get(Math.floor(index / PAGE))?.[index % PAGE];
  const names = useMemo(() => columns.map((column) => column.name), [columns]);
  const numeric = useMemo(() => columns.map((column) => isNumericType(column.type)), [columns]);
  const loadedRows = (from: number, to: number): Cell[][] => {
    const rows: Cell[][] = [];
    for (let index = Math.max(0, from); index <= Math.min(total - 1, to); index++) {
      const row = rowAt(index);
      if (row) rows.push(row);
    }
    return rows;
  };
  const visibleRows = () => ({ columns: names, rows: loadedRows(firstIndex, lastIndex) });
  useImperativeHandle(handle, () => ({ visibleRows }));

  const copy = async () => {
    const rows = selection ? loadedRows(Math.min(selection.anchor, selection.focus), Math.max(selection.anchor, selection.focus)) : visibleRows().rows;
    const result = await copyText(tsv(names, rows));
    if (result !== "empty") setCopyState(result);
  };
  const cycleSort = (column: string) => setSort((current) =>
    current?.column !== column ? { column, direction: "asc" } : current.direction === "asc" ? { column, direction: "desc" } : undefined);
  const select = (index: number, extend: boolean) => setSelection((current) =>
    extend && current ? { anchor: current.anchor, focus: index } : { anchor: index, focus: index });
  const selected = (index: number) => Boolean(selection) && index >= Math.min(selection!.anchor, selection!.focus) && index <= Math.max(selection!.anchor, selection!.focus);
  // Dragging a header's right edge sets that column's width; pointer capture
  // keeps the drag alive when the pointer leaves the handle.
  const startResize = (index: number, event: ReactPointerEvent<HTMLSpanElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = widths[index] ?? 160;
    const handleEl = event.currentTarget;
    handleEl.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      const next = Math.max(60, Math.min(800, startWidth + moveEvent.clientX - startX));
      setWidths((current) => current.map((width, column) => column === index ? next : width));
    };
    const stop = () => {
      handleEl.removeEventListener("pointermove", move);
      handleEl.removeEventListener("pointerup", stop);
      handleEl.removeEventListener("pointercancel", stop);
    };
    handleEl.addEventListener("pointermove", move);
    handleEl.addEventListener("pointerup", stop);
    handleEl.addEventListener("pointercancel", stop);
  };

  const height = Math.min(MAX_HEIGHT, HEADER_HEIGHT + Math.max(1, total) * ROW_HEIGHT + 2);
  const before = items.length ? Math.max(0, items[0]!.start - HEADER_HEIGHT) : 0;
  const after = items.length ? Math.max(0, virtualizer.getTotalSize() - items.at(-1)!.end + HEADER_HEIGHT) : 0;
  const tableWidth = widths.reduce((sum, width) => sum + width, 0);
  const filtered = live.total !== null && filter !== "";

  return (
    <div className="data-grid min-w-0 overflow-hidden rounded-xl border border-hairline/50 bg-panel text-ink">
      <div className="flex items-center gap-1 border-b border-hairline/40 px-2 py-1">
        <label className="flex min-w-24 flex-1 items-center gap-2 px-1 text-ink-secondary">
          <Search size={13} aria-hidden="true" />
          <input value={filterText} onChange={(event) => setFilterText(event.target.value)} aria-label={t("data.grid.filter")} placeholder={t("data.grid.filter")}
            className="w-full min-w-0 bg-transparent py-1 text-xs text-ink outline-none placeholder:text-ink-tertiary focus-visible:ring-1 focus-visible:ring-accent" />
        </label>
        <button type="button" className="table-action" aria-label={t("data.grid.copy")} title={t("data.grid.copyHint")} onClick={() => void copy()}>
          {copyState === "copied" ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <div ref={scroll} tabIndex={0} role="region" aria-label={t("data.grid.label", { name })} style={{ height }}
        onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "c" && selection) { event.preventDefault(); void copy(); } }}
        className="overflow-auto overscroll-x-contain focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60">
        <table aria-rowcount={total + 1} className="table-fixed border-separate border-spacing-0 text-[12.5px]" style={{ width: tableWidth, minWidth: "100%" }}>
          <colgroup>{widths.map((width, index) => <col key={index} style={{ width }} />)}</colgroup>
          <thead className="sticky top-0 z-10 bg-raised"><tr aria-rowindex={1} style={{ height: HEADER_HEIGHT }}>
            {columns.map((column, index) => (
              <th key={column.name} scope="col" aria-sort={sort?.column === column.name ? sort.direction === "desc" ? "descending" : "ascending" : "none"}
                className="relative border-b border-hairline/60 px-0 font-medium" style={{ textAlign: numeric[index] ? "right" : "left" }}>
                <button type="button" onClick={() => cycleSort(column.name)} aria-label={t("data.grid.sort", { column: column.name })} title={column.type}
                  className={cn("flex h-full w-full items-center gap-1 px-2.5 py-1.5 hover:bg-raised-hover", numeric[index] && "flex-row-reverse")}>
                  <span className="min-w-0 truncate">{column.name}</span>
                  {sort?.column === column.name
                    ? sort.direction === "desc" ? <ArrowDown size={12} className="shrink-0" /> : <ArrowUp size={12} className="shrink-0" />
                    : <span className="shrink-0 text-[10px] font-normal text-ink-tertiary">{column.type.toLowerCase()}</span>}
                </button>
                <span role="separator" aria-label={t("data.grid.resize", { column: column.name })} onPointerDown={(event) => startResize(index, event)}
                  className="absolute inset-y-0 right-0 w-1.5 cursor-col-resize touch-none hover:bg-accent/40" />
              </th>
            ))}
          </tr></thead>
          <tbody>
            {before > 0 && <tr aria-hidden="true"><td colSpan={columns.length} style={{ height: before, padding: 0 }} /></tr>}
            {items.map((item) => {
              const row = rowAt(item.index);
              return (
                <tr key={item.key} data-index={item.index} aria-rowindex={item.index + 2} aria-selected={selected(item.index)}
                  onClick={(event) => select(item.index, event.shiftKey)} style={{ height: ROW_HEIGHT }}
                  className={cn("cursor-default", selected(item.index) ? "bg-accent/15" : item.index % 2 ? "bg-inset/35 hover:bg-raised/70" : "hover:bg-raised/70")}>
                  {columns.map((column, index) => {
                    const cell = row?.[index];
                    return (
                      <td key={column.name} className="border-b border-hairline/20 px-2.5 align-middle tabular-nums" style={{ textAlign: numeric[index] ? "right" : "left" }}>
                        {row === undefined
                          ? <span className="block h-3 w-2/3 animate-pulse rounded bg-inset" aria-hidden="true" />
                          : cell === null || cell === undefined
                            ? <span className="text-ink-tertiary">{t("data.grid.null")}</span>
                            : <span className="block truncate" title={cellText(cell)}>{cellText(cell)}</span>}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {after > 0 && <tr aria-hidden="true"><td colSpan={columns.length} style={{ height: after, padding: 0 }} /></tr>}
          </tbody>
        </table>
        {total === 0 && live.total !== null && <p className="p-6 text-center text-[12px] text-ink-secondary">{t("data.grid.empty")}</p>}
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline/40 px-3 py-1.5 text-[11px] text-ink-secondary">
        <span role="status">
          {filtered
            ? t("data.grid.countFiltered", { shown: formatCount(total), total: formatCount(rowCount), columns: columns.length })
            : t("data.grid.count", { count: formatCount(total), columns: columns.length })}
        </span>
        {live.error && <span role="alert" className="text-danger">{t("data.grid.loadFailed", { reason: live.error })}</span>}
        {copyState !== "idle" && <span role={copyState === "failed" ? "alert" : "status"}>{t(copyState === "failed" ? "data.card.copyFailed" : "data.card.copied")}</span>}
      </footer>
    </div>
  );
}
