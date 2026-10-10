import { useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { AgGridReact } from "ag-grid-react";
import { CellStyleModule, InfiniteRowModelModule, RenderApiModule, RowApiModule, RowSelectionModule, ScrollApiModule, TooltipModule, themeQuartz, type ColDef, type GridApi, type IDatasource, type IRowNode } from "ag-grid-community";
import { DATA_LIMITS, DATA_ROUTES, type DataColumn, type DataPage, type DataPageRequest } from "../../../shared/data-surface";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import { copyText } from "@/lib/copy-text";
import { cellText, defaultColumnWidth, formatCount, isNumericType, tsv, type Cell } from "./data-format";
import { DataFilter, type DataFilterValue } from "./DataFilter";

export interface DataGridHandle {
  visibleRows(): { columns: string[]; rows: Cell[][] };
}

export interface DataGridProps {
  botId: string;
  target: { cardId: string } | { table: string };
  columns: DataColumn[];
  rowCount: number;
  name: string;
  /** A result can be replaced without changing its id or row count. */
  revision?: string;
  handle?: RefObject<DataGridHandle | null>;
  footerControls?: ReactNode;
}

export interface DataGridRow { index: number; cells: Cell[] }
export interface DataGridDatasource extends IDatasource { invalidate(): void }

/** Each datasource owns only its in-flight requests; AG Grid owns a bounded block cache. */
export function createDataGridDatasource({ botId, target, columns, rowCount, filter, filterColumn, isCurrent = () => true, onPage, onError }: {
  botId: string;
  target: DataGridProps["target"];
  columns: DataColumn[];
  rowCount: number;
  filter: string;
  filterColumn?: string;
  isCurrent?: () => boolean;
  onPage: (page: DataPage) => void;
  onError: (message: string) => void;
}): DataGridDatasource {
  let destroyed = false;
  let generation = 0;
  let sortKey = "";
  const pending = new Map<AbortController, () => void>();
  const invalidate = () => {
    generation++;
    for (const [controller, fail] of pending) { controller.abort(); fail(); }
    pending.clear();
  };
  return {
    rowCount: filter ? undefined : rowCount,
    invalidate,
    destroy() { destroyed = true; invalidate(); },
    getRows(params) {
      if (destroyed || !isCurrent()) { params.failCallback(); return; }
      const selectedSort = params.sortModel.find((item) => columns.some((column) => column.name === item.colId));
      const sort: DataPageRequest["sort"] = selectedSort ? { column: selectedSort.colId, direction: selectedSort.sort } : undefined;
      const nextSortKey = JSON.stringify(sort ?? null);
      if (sortKey !== nextSortKey) { invalidate(); sortKey = nextSortKey; }
      if (params.startRow >= rowCount) { params.successCallback([], rowCount); return; }
      const controller = new AbortController();
      const requestGeneration = generation;
      let settled = false;
      // Even cancelled blocks must finish: AG Grid releases a loader slot only on a callback.
      const fail = () => {
        if (settled) return;
        settled = true;
        pending.delete(controller);
        params.failCallback();
      };
      pending.set(controller, fail);
      const current = () => !destroyed && !controller.signal.aborted && generation === requestGeneration && isCurrent();
      const request: DataPageRequest = {
        ...target,
        offset: params.startRow,
        limit: Math.min(DATA_LIMITS.pageSize, params.endRow - params.startRow, rowCount - params.startRow),
        ...(sort ? { sort } : {}), ...(filter ? { filter, ...(filterColumn !== undefined ? { filterColumn } : {}) } : {}),
      };
      void api<DataPage>(DATA_ROUTES.page(botId), { method: "POST", body: JSON.stringify(request), signal: controller.signal }).then((page) => {
        if (settled) return;
        if (!current()) { fail(); return; }
        settled = true;
        pending.delete(controller);
        onPage(page);
        params.successCallback(page.rows.map((cells, index): DataGridRow => ({ index: page.offset + index, cells })), page.rowCount);
      }).catch((cause) => {
        if (settled) return;
        if (current()) onError(cause instanceof Error ? cause.message : String(cause));
        fail();
      });
    },
  };
}

const modules = [InfiniteRowModelModule, RowSelectionModule, RowApiModule, RenderApiModule, ScrollApiModule, CellStyleModule, TooltipModule];
const gridTheme = themeQuartz.withParams({
  browserColorScheme: "var(--code-color-scheme)",
  fontFamily: "var(--font-sans)", fontSize: 12.5, headerFontWeight: 500,
  backgroundColor: "var(--color-panel)", foregroundColor: "var(--color-ink)",
  headerBackgroundColor: "var(--color-raised)", headerTextColor: "var(--color-ink)",
  borderColor: "color-mix(in srgb, var(--color-hairline) 40%, transparent)",
  rowBorder: { color: "color-mix(in srgb, var(--color-hairline) 20%, transparent)" },
  rowHoverColor: "var(--color-raised-hover)",
  selectedRowBackgroundColor: "color-mix(in srgb, var(--color-accent) 15%, transparent)",
  accentColor: "var(--color-accent)", wrapperBorder: false, wrapperBorderRadius: 0,
  cellHorizontalPadding: 10,
});
const rowSelection = { mode: "multiRow", checkboxes: false, headerCheckbox: false, enableClickSelection: true } as const;
const defaultColDef: ColDef<DataGridRow> = { sortable: true, resizable: true, cellDataType: false, filter: false, suppressMovable: true };
const rowsFromNodes = (nodes: IRowNode<DataGridRow>[]) => nodes.filter((node) => node.data).sort((left, right) => (left.rowIndex ?? 0) - (right.rowIndex ?? 0)).map((node) => node.data!.cells);

export function DataResultFooter({ children, controls }: { children?: ReactNode; controls?: ReactNode }) {
  return <footer className="relative flex h-11 shrink-0 items-center gap-2 border-t border-hairline/40 px-3 text-[11px] text-ink-secondary" data-testid="data-result-footer">
    <div className="min-w-0 flex-1 truncate">{children}</div>
    <div className="flex shrink-0 items-center gap-1">{controls}</div>
  </footer>;
}

/** Community's infinite model pages the existing SQL result; no browser-side load-all or sort. */
export function DataGrid({ botId, target, columns, rowCount, name, revision, handle, footerControls }: DataGridProps) {
  const grid = useRef<GridApi<DataGridRow> | null>(null);
  const [readyGrid, setReadyGrid] = useState<GridApi<DataGridRow> | null>(null);
  const source = useRef<DataGridDatasource | null>(null);
  const [filterInput, setFilterInput] = useState<DataFilterValue>({ text: "" });
  const [appliedFilter, setAppliedFilter] = useState<DataFilterValue>({ text: "" });
  const validFilter = (value: DataFilterValue) => value.column === undefined || columns.some((column) => column.name === value.column);
  const filterValue = validFilter(filterInput) ? filterInput : { text: "" };
  const filter = validFilter(appliedFilter) ? appliedFilter.text : "";
  const filterColumn = filter ? appliedFilter.column : undefined;
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const schemaKey = JSON.stringify(columns.map(({ name, type }) => ({ name, type })));
  const key = JSON.stringify([botId, target, revision, rowCount, filter, filterColumn, schemaKey]);
  const currentKey = useRef(key);
  currentKey.current = key;
  const [status, setStatus] = useState<{ key: string; total: number; error: string | null }>({ key, total: rowCount, error: null });
  const total = status.key === key ? status.total : rowCount;
  const error = status.key === key ? status.error : null;
  const columnDefs = useMemo<ColDef<DataGridRow>[]>(() => columns.map((column, index) => ({
    colId: column.name, headerName: column.name, headerTooltip: column.type, minWidth: defaultColumnWidth(column), initialFlex: 1,
    // Keep dotted/quoted names and exact BIGINT/DECIMAL strings out of object field coercion.
    valueGetter: (params) => params.data?.cells[index],
    valueFormatter: ({ value, data }) => !data ? "" : value === null || value === undefined ? t("data.grid.null") : cellText(value),
    tooltipValueGetter: ({ value }) => value === null || value === undefined ? t("data.grid.null") : cellText(value),
    cellStyle: { textAlign: isNumericType(column.type) ? "right" : "left", fontVariantNumeric: "tabular-nums" },
    cellClass: ({ value, data }) => data && (value === null || value === undefined) ? "text-ink-tertiary" : "",
  })), [schemaKey]);
  useEffect(() => {
    if (!readyGrid || readyGrid.isDestroyed()) return;
    // A fresh source belongs to this actual grid lifetime, including StrictMode remounts.
    const datasource = createDataGridDatasource({
      botId, target, columns, rowCount, filter, filterColumn,
      isCurrent: () => currentKey.current === key && grid.current === readyGrid && !readyGrid.isDestroyed(),
      onPage: (page) => setStatus({ key, total: page.rowCount, error: null }),
      onError: (message) => setStatus((current) => ({ key, total: current.key === key ? current.total : rowCount, error: message })),
    });
    source.current = datasource;
    readyGrid.deselectAll();
    readyGrid.setGridOption("datasource", datasource);
    if (rowCount > 0) readyGrid.ensureIndexVisible(0, "top");
    return () => { datasource.destroy?.(); if (source.current === datasource) source.current = null; };
  }, [readyGrid, key]);
  useEffect(() => {
    if (!validFilter(filterInput)) { setFilterInput({ text: "" }); setAppliedFilter({ text: "" }); return; }
    const timer = setTimeout(() => setAppliedFilter({ ...filterInput, text: filterInput.text.trim() }), 250);
    return () => clearTimeout(timer);
  }, [filterInput, schemaKey]);
  useEffect(() => {
    if (copyState === "idle") return;
    const timer = setTimeout(() => setCopyState("idle"), 1500);
    return () => clearTimeout(timer);
  }, [copyState]);

  const names = columns.map((column) => column.name);
  const visibleRows = () => ({ columns: names, rows: rowsFromNodes(grid.current?.getRenderedNodes() ?? []) });
  useImperativeHandle(handle, () => ({ visibleRows }));
  const copy = async () => {
    const selected = rowsFromNodes(grid.current?.getSelectedNodes() ?? []);
    const rows = selected.length ? selected : visibleRows().rows;
    if (!rows.length) return;
    const result = await copyText(tsv(names, rows));
    if (result !== "empty") setCopyState(result);
  };

  return (
    <div className="data-grid flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-panel text-ink" data-row-count={total}>
      <div className="flex shrink-0 items-center border-b border-hairline/40 px-2 py-1">
        <DataFilter columns={columns} value={filterValue} onChange={(value) => {
          setFilterInput(value);
          if (!value.text.trim() || value.column !== filterInput.column) setAppliedFilter({ ...value, text: value.text.trim() });
        }} />
      </div>
      <div role="region" aria-label={t("data.grid.label", { name })} className="min-h-0 flex-1" data-testid="data-grid-viewport"
        onKeyDownCapture={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c" && !window.getSelection()?.toString()) {
            event.preventDefault(); event.stopPropagation(); void copy();
          }
        }}>
        <AgGridReact<DataGridRow> modules={modules} theme={gridTheme} loadThemeGoogleFonts={false}
          columnDefs={columnDefs} defaultColDef={defaultColDef} rowModelType="infinite"
          cacheBlockSize={DATA_LIMITS.pageSize} maxBlocksInCache={4} maxConcurrentDatasourceRequests={2} infiniteInitialRowCount={rowCount}
          rowHeight={36} headerHeight={40} rowBuffer={8} animateRows={false} suppressMultiSort={true}
          rowSelection={rowSelection} enableCellTextSelection={true} ensureDomOrder={true}
          onGridReady={({ api: gridApi }) => { grid.current = gridApi; setReadyGrid(gridApi); gridApi.setGridAriaProperty("label", t("data.grid.label", { name })); }}
          onGridPreDestroyed={({ api: gridApi }) => { if (grid.current === gridApi) { grid.current = null; source.current?.destroy?.(); } }}
          onSortChanged={({ api: gridApi }) => { source.current?.invalidate(); gridApi.deselectAll(); }} />
      </div>
      <DataResultFooter controls={footerControls}>
        <span role="status">{t(filter ? "data.grid.countFiltered" : "data.grid.count", { shown: formatCount(total), total: formatCount(rowCount), count: formatCount(total), columns: columns.length })}</span>
        {error && <span role="alert" className="ml-2 text-danger" title={error}>{t("data.grid.loadFailed", { reason: error })}</span>}
        {copyState !== "idle" && <span role={copyState === "failed" ? "alert" : "status"}>{t(copyState === "failed" ? "data.card.copyFailed" : "data.card.copied")}</span>}
      </DataResultFooter>
    </div>
  );
}
