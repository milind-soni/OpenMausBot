import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { Result } from "vega-embed";
import { DATA_LIMITS, DATA_ROUTES, type DataPage } from "../../../shared/data-surface";
import { vegaConfig } from "../../../shared/vega-config";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import type { ColorScheme } from "@/lib/color-scheme";
import { rowObjects, type Cell } from "./data-format";

export interface DataChartProps {
  botId: string;
  cardId: string;
  /** The compiled Vega-Lite spec, data-free; the rows bind as dataset "table". */
  spec: Record<string, unknown>;
  /** Rows after the server's reduction (at most DATA_LIMITS.chartMaxMarks). */
  rowCount: number | undefined;
  theme: ColorScheme;
  revision?: string;
}

/** The reduced rows, paged like the grid pages: never more than pageSize
 * per request, never more than the chart cap in total. */
export async function fetchChartRows(botId: string, cardId: string, rowCount: number | undefined, signal?: AbortSignal): Promise<Array<Record<string, Cell>>> {
  const rows: Array<Record<string, Cell>> = [];
  let offset = 0;
  let total = Math.min(rowCount ?? DATA_LIMITS.pageSize, DATA_LIMITS.chartMaxMarks);
  while (offset < total) {
    signal?.throwIfAborted();
    const page = await api<DataPage>(DATA_ROUTES.page(botId), {
      method: "POST",
      body: JSON.stringify({ cardId, offset, limit: Math.min(DATA_LIMITS.pageSize, total - offset) }),
      signal,
    });
    rows.push(...rowObjects(page.columns, page.rows));
    total = Math.min(page.rowCount, DATA_LIMITS.chartMaxMarks);
    if (page.rows.length === 0) break;
    offset += page.rows.length;
  }
  return rows;
}

/** The spec with the rows bound as the dataset named "table", sized to its
 * container so it follows the card's width. A spec that already names its
 * data keeps that; one without any gets the table. Concat and repeat specs
 * size their own children, so only unit and layer specs get the width. */
export function bindChartRows(spec: Record<string, unknown>, rows: Array<Record<string, Cell>>): Record<string, unknown> {
  const datasets = { ...(spec.datasets as Record<string, unknown> | undefined), table: rows };
  const unit = "mark" in spec || "layer" in spec;
  return {
    ...spec,
    ...(spec.data ? {} : { data: { name: "table" } }),
    datasets,
    ...(unit ? { width: "container", autosize: { type: "fit", contains: "padding" } } : {}),
  };
}

/** A Vega-Lite chart of a card's reduced rows. vega-embed (~270 KB gzipped)
 * loads on the first chart, not with the app. The theme comes from the
 * skin; the shared config carries OMB's palette and fonts. */
export function DataChart({ botId, cardId, spec, rowCount, theme, revision }: DataChartProps) {
  const host = useRef<HTMLDivElement>(null);
  const displayed = useRef<{ result: Result; naturalHeight?: number } | null>(null);
  const [state, setState] = useState<{ loading: boolean; error: string | null }>({ loading: true, error: null });
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      const current = displayed.current;
      if (!current) return;
      if (current.naturalHeight && element.clientHeight > 0) current.result.view.height(Math.min(current.naturalHeight, element.clientHeight));
      void current.result.view.resize().runAsync().catch(() => undefined);
    });
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      displayed.current?.result.finalize();
      displayed.current = null;
      element.replaceChildren();
    };
  }, []);
  // The sheet is replaced whole on every frame, so the spec object changes
  // identity without changing; redraw only when its content does.
  const specText = JSON.stringify(spec);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let alive = true;
    let candidate: HTMLDivElement | undefined;
    let candidateResult: Result | undefined;
    let committed = false;
    const abort = new AbortController();
    const discardCandidate = () => {
      candidateResult?.finalize();
      candidateResult = undefined;
      candidate?.remove();
    };
    setState({ loading: displayed.current === null, error: null });
    void (async () => {
      const [{ default: embed }, rows] = await Promise.all([import("vega-embed"), fetchChartRows(botId, cardId, rowCount, abort.signal)]);
      if (!alive) return;
      const bound = bindChartRows(JSON.parse(specText) as Record<string, unknown>, rows);
      const unit = "mark" in bound || "layer" in bound;
      let naturalHeight = unit && typeof bound.height === "number" ? bound.height : undefined;
      if (naturalHeight && element.clientHeight > 0) bound.height = Math.min(naturalHeight, element.clientHeight);
      // Attached but out of flow: Vega measures the real width without hiding the last good chart.
      candidate = document.createElement("div");
      Object.assign(candidate.style, { position: "absolute", top: "0", left: "0", width: "100%", visibility: "hidden" });
      candidate.setAttribute("aria-hidden", "true");
      element.append(candidate);
      // SAFETY: the server validated the spec against Vega-Lite's schema and
      // rendered it once headlessly; embed throws on anything it still rejects.
      const embedded = await embed(candidate, bound as Parameters<typeof embed>[1], { actions: false, config: vegaConfig(theme) });
      candidateResult = embedded;
      if (!alive) { discardCandidate(); return; }
      // Keep a chart's preferred height in a tall panel; shrink only to fit the available output.
      naturalHeight ??= unit ? candidate.clientHeight || undefined : undefined;
      let fittedHeight = bound.height;
      while (naturalHeight && element.clientHeight > 0) {
        const height = Math.min(naturalHeight, element.clientHeight);
        if (height === fittedHeight) break;
        embedded.view.height(height);
        await embedded.view.resize().runAsync();
        if (!alive) { discardCandidate(); return; }
        fittedHeight = height;
      }
      const previous = displayed.current;
      candidate.style.position = "";
      candidate.style.visibility = "";
      candidate.removeAttribute("aria-hidden");
      element.replaceChildren(candidate);
      displayed.current = { result: embedded, naturalHeight };
      committed = true;
      previous?.result.finalize();
      setState({ loading: false, error: null });
    })().catch((cause) => {
      if (!committed) discardCandidate();
      if (alive) setState({ loading: false, error: cause instanceof Error ? cause.message : String(cause) });
    });
    return () => {
      alive = false;
      abort.abort();
      if (!committed) discardCandidate();
    };
  }, [botId, cardId, specText, rowCount, theme, revision]);
  return (
    <div className="relative min-h-0 w-full flex-1" data-testid="data-chart">
      <div ref={host} className="relative h-full w-full" />
      {state.loading && (
        <div className="absolute inset-0 flex items-center justify-center gap-2 text-[12px] text-ink-secondary" role="status">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />{t("data.chart.loading")}
        </div>
      )}
      {state.error && <p role="alert" className="absolute inset-x-0 bottom-0 z-10 max-h-20 overflow-auto rounded bg-panel/95 px-3 py-2 text-[12px] text-danger">{t("data.chart.failed", { reason: state.error })}</p>}
    </div>
  );
}
