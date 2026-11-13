// A widget's Chart as a Vega-Lite spec, drawn with the same config as every
// other chart, so its palette, type and hairlines match the Data panel's. Pure,
// so the server can render the same spec headless for a client that cannot.
import { widgetNumber, type WidgetNode } from "./widget.ts";

interface ChartSeries {
  type: "bar" | "line" | "area";
  dataKey: string;
  label: string;
  stack?: string;
}

/** The inside of a 600px card, used until the chart has been measured. */
export const WIDGET_CHART_WIDTH = 560;
/** The legend's line under the plot. */
const LEGEND_BAND = 24;

function readChart(node: WidgetNode): { rows: Array<Record<string, unknown>>; series: ChartSeries[]; xKey: string } {
  const rows = (Array.isArray(node.data) ? node.data as unknown[] : []).filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row));
  const series = (Array.isArray(node.series) ? node.series as unknown[] : []).flatMap((item): ChartSeries[] => {
    const record: Record<string, unknown> = item && typeof item === "object" ? item as Record<string, unknown> : {};
    if (typeof record.dataKey !== "string") return [];
    return [{
      type: record.type === "line" || record.type === "area" ? record.type : "bar",
      dataKey: record.dataKey,
      label: typeof record.label === "string" ? record.label : record.dataKey,
      ...(typeof record.stack === "string" ? { stack: record.stack } : {}),
    }];
  }).slice(0, 4);
  const axis = node.xAxis && typeof node.xAxis === "object" ? node.xAxis as { dataKey?: unknown } : {};
  return { rows, series, xKey: typeof axis.dataKey === "string" ? axis.dataKey : "" };
}

/** A legend is worth its line when there is more than one series, or the one
 * series has a name of its own. */
function hasLegend(node: WidgetNode, series: ChartSeries[]): boolean {
  return node.showLegend !== false && (series.length > 1 || (series.length === 1 && series[0]!.label !== series[0]!.dataKey));
}

/** The chart's height, legend included, for a card `width` wide: its own
 * height, else its aspect ratio, else 160; the plot never under 80 or over 400. */
export function widgetChartHeight(node: WidgetNode, width: number): number {
  const ratio = widgetNumber(node, "aspectRatio");
  const plot = Math.round(Math.min(400, Math.max(80, widgetNumber(node, "height") ?? (ratio ? width / ratio : 160))));
  return plot + (hasLegend(node, readChart(node).series) ? LEGEND_BAND : 0);
}

/** The Vega-Lite spec for a Chart node, its rows inline and its width the
 * container's; null when there is nothing to draw. Bars that share a `stack`
 * pile up in one slot of the row's band (rising and falling piles apart); the
 * rest sit side by side. Lines and areas break where a row has no value. */
export function widgetChartSpec(node: WidgetNode, width = WIDGET_CHART_WIDTH): Record<string, unknown> | null {
  const { rows, series, xKey } = readChart(node);
  if (!rows.length || !series.length) return null;
  const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 });
  const rowLabels = rows.map((row) => {
    const value = row[xKey];
    return typeof value === "string" || typeof value === "number" ? String(value) : "";
  });
  // Rows and series are keyed by position, so two rows named alike stay two
  // bands and two series labelled alike keep their own colours.
  const groups: string[] = [];
  const values = rows.flatMap((row, at) => series.map((item, index) => {
    const raw = row[item.dataKey];
    const value = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    const group = item.stack ? `stack:${item.stack}` : `series:${index}`;
    if (item.type === "bar" && !groups.includes(group)) groups.push(group);
    return { row: at, series: index, group, mark: item.type, value, tip: value === null ? null : `${rowLabels[at]} · ${item.label}: ${compact.format(value)}` };
  }));
  const highest = Math.max(0, ...values.map((datum) => Math.abs(datum.value ?? 0)));
  const showGrid = node.showGrid !== false;
  const yAxis = node.showYAxis === true
    ? { title: null, grid: showGrid, tickCount: 4, ...(highest >= 10_000 ? { format: "~s", labelExpr: "replace(datum.label, 'G', 'B')" } : {}) }
    : showGrid ? { title: null, grid: true, tickCount: 4, labels: false, ticks: false, domain: false } : null;
  const y = (stack: "zero" | null) => ({ field: "value", type: "quantitative", stack, axis: yAxis });
  const has = (type: ChartSeries["type"]) => series.some((item) => item.type === type);
  const stacked = series.some((item) => item.type === "bar" && item.stack);
  const point = rows.length > 40 ? false : { size: rows.length > 16 ? 8 : 24 };
  const layer = [
    has("bar") && {
      transform: [{ filter: "datum.mark === 'bar' && datum.value !== null" }],
      mark: { type: "bar", ...(stacked ? {} : { cornerRadiusEnd: 3 }) },
      encoding: {
        y: y("zero"),
        // the first series at the foot of its pile, as it is listed
        order: { field: "series", type: "quantitative" },
        ...(groups.length > 1 ? { xOffset: { field: "group", type: "nominal", scale: { domain: groups, paddingInner: 0.08 } } } : {}),
      },
    },
    has("area") && {
      transform: [{ filter: "datum.mark === 'area'" }],
      mark: { type: "area", opacity: 0.18, line: false },
      encoding: { y: y(null) },
    },
    (has("line") || has("area")) && {
      transform: [{ filter: "datum.mark !== 'bar'" }],
      mark: { type: "line", point },
      encoding: { y: y(null) },
    },
  ].filter(Boolean);
  const legend = hasLegend(node, series)
    ? { title: null, orient: "bottom", direction: "horizontal", symbolOpacity: 1, labelExpr: "seriesLabels[datum.value]", ...(series.reduce((sum, item) => sum + item.label.length, 0) > 48 ? { columns: 2 } : {}) }
    : null;
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    width: "container",
    height: widgetChartHeight(node, width),
    autosize: { type: "fit", contains: "padding" },
    padding: { top: 4, right: 0, bottom: 0, left: 0 },
    params: [{ name: "rowLabels", value: rowLabels }, { name: "seriesLabels", value: series.map((item) => item.label) }],
    data: { values },
    encoding: {
      x: {
        field: "row",
        type: "ordinal",
        scale: { domain: rows.map((_, at) => at) },
        axis: { title: null, labelAngle: 0, labelLimit: 90, labelOverlap: "greedy", labelExpr: "rowLabels[datum.value]" },
      },
      color: { field: "series", type: "nominal", scale: { domain: series.map((_, index) => index) }, legend },
      // what a mark says on hover is also what it is called to a screen reader
      tooltip: { field: "tip", type: "nominal" },
      description: { field: "tip", type: "nominal" },
    },
    layer,
  };
}
