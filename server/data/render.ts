// No node-canvas: Vega estimates text widths without one, so a label can sit a few pixels off its true extent.
import type { Resvg as ResvgClass } from "@resvg/resvg-js";
import { None, logger, parse, View } from "vega";
import { compile, type Config, type TopLevelSpec } from "vega-lite";

import { vegaConfig, vegaSurface, type VegaTheme } from "../../shared/vega-config.ts";
import { columnClass } from "./chart-compiler.ts";
import { nativeRequire } from "./engine.ts";
import type { ChartRenderer, DataColumn, RunResult } from "./types.ts";

/** Required at first use from the staged tree: a static import would make esbuild bundle its .node file, which it cannot. */
let resvgModule: { Resvg: typeof ResvgClass } | null = null;
function loadResvg(): typeof ResvgClass {
  resvgModule ??= nativeRequire()("@resvg/resvg-js") as { Resvg: typeof ResvgClass };
  return resvgModule.Resvg;
}

export const DEFAULT_WIDTH = 720;

type Cell = RunResult["rows"][number][number];

/** A naive date or timestamp is wall-clock time, parsed in the local zone: `new Date("2024-03-01")` would be UTC midnight. */
const NAIVE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?$/;
export function parseTemporal(text: string): Date | string {
  const m = NAIVE.exec(text);
  if (m) {
    const millis = m[7] ? Number(m[7].padEnd(3, "0").slice(0, 3)) : 0;
    const date = new Date(0);
    date.setFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    date.setHours(Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0), millis);
    return date;
  }
  const zoned = new Date(text.replace(" ", "T"));
  return Number.isNaN(zoned.getTime()) ? text : zoned;
}

export function coerceRows(rows: RunResult["rows"], columns: DataColumn[]): Array<Record<string, unknown>> {
  const coercers = columns.map((column) => {
    const cls = columnClass(column.type);
    if (cls === "numeric") return (v: Cell): unknown => (typeof v === "string" ? Number(v) : v);
    if (cls === "temporal") return (v: Cell): unknown => (typeof v === "string" ? parseTemporal(v) : v);
    return (v: Cell): unknown => v;
  });
  return rows.map((row) => {
    const datum: Record<string, unknown> = {};
    columns.forEach((column, i) => {
      datum[column.name] = coercers[i]!(row[i] ?? null);
    });
    return datum;
  });
}

const silent = logger(None);

function sized(vegaLite: Record<string, unknown>, width: number): Record<string, unknown> {
  const spec = { ...vegaLite };
  if (spec.width === "container" || (spec.width === undefined && ("mark" in spec || "layer" in spec))) spec.width = width;
  return spec;
}

async function svg(vegaLite: Record<string, unknown>, rows: RunResult["rows"], columns: DataColumn[], options: { theme: VegaTheme; width?: number }): Promise<string> {
  const spec = sized(vegaLite, options.width ?? DEFAULT_WIDTH);
  const { spec: runtime } = compile(spec as unknown as TopLevelSpec, { config: vegaConfig(options.theme) as Config, logger: silent });
  const view = new View(parse(runtime), { renderer: "none" }).logger(silent);
  try {
    view.data("table", coerceRows(rows, columns));
    return await view.toSVG();
  } finally {
    view.finalize();
  }
}

async function png(
  vegaLite: Record<string, unknown>,
  rows: RunResult["rows"],
  columns: DataColumn[],
  options: { theme: VegaTheme; width?: number; scale?: number },
): Promise<Buffer> {
  const width = options.width ?? DEFAULT_WIDTH;
  const markup = await svg(vegaLite, rows, columns, { theme: options.theme, width });
  // A PNG lands in an email or Slack message that paints no ground of its own, so it gets the theme's surface.
  const Resvg = loadResvg();
  const image = new Resvg(markup, {
    fitTo: { mode: "width", value: Math.round(width * (options.scale ?? 1)) },
    background: vegaSurface(options.theme),
    font: { loadSystemFonts: true, defaultFontFamily: "Helvetica" },
  });
  return Buffer.from(image.render().asPng());
}

export const chartRenderer: ChartRenderer = { svg, png };
