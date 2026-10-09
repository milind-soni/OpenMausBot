// A bot's small chart spec → the SQL that reduces the data and the Vega-Lite
// that draws the result (PLAN D5, D7). The model never writes a chart
// grammar, and raw rows never reach a renderer: every statement here
// aggregates, bins, folds, buckets, samples or M4-downsamples in DuckDB, and
// the panel binds what comes back as the dataset named "table".
//
// The compiler sees the spec, the result's columns and where to read from
// — never the data. So every reduction is written to be safe at any size:
// the top-N fold only folds when there are more than N categories, the time
// unit is picked inside the SQL from the data's own range, M4 keeps at most
// four points per pixel column, the scatter sample caps itself. The one
// thing SQL cannot promise is a bound on grouped output (a heatmap of two
// wide columns), so every statement ends with `LIMIT CHART_SQL_LIMIT`: a
// result of exactly that many rows means the reduction overflowed and the
// caller answers `output_too_large` rather than drawing a truncated chart.
//
// Output columns are named for the Vega-Lite channel they feed (x, x2, y,
// y2, color, size), never for the source column: a source may itself have a
// column called "count" or "x", and a bin start or a fold has no source name.
// Axis titles and tooltips carry the source names instead.
import { DATA_LIMITS } from "../../shared/data-surface.ts";
import { DataFailure, type ChartCompiler, type CompiledChart, type DataColumn, type OmbChartSpec } from "./types.ts";

/** One more row than a chart may draw. A result with this many rows is an
 * overflow, never a chart; below it the count is exact. */
export const CHART_SQL_LIMIT = DATA_LIMITS.chartMaxMarks + 1;
/** Categories kept before the rest fold into "other" (Hex, sqlrooms: 20). */
export const TOP_N_DEFAULT = 20;
export const BINS_DEFAULT = 30;
/** A time axis aims for at most this many buckets when the spec names no
 * unit; the SQL picks the coarsest unit that stays under it. */
export const TIME_BUCKETS_TARGET = 500;
/** Pixel columns for M4. A card is narrower than this on a laptop, and four
 * points per column reproduce the rasterised line exactly at that width. */
export const M4_WIDTH = 800;
/** Reservoir sampling is repeatable so a refresh draws the same points. */
export const SAMPLE_SEED = 42;

export type ColumnClass = "numeric" | "temporal" | "categorical" | "boolean";

/** What a DuckDB type name means for a chart. Nested types (lists, structs,
 * maps) and everything unknown are categorical: they can be grouped by their
 * text, nothing else. */
export function columnClass(type: string): ColumnClass {
  const t = type.trim().toUpperCase();
  if (t.includes("[") || /^(STRUCT|MAP|LIST|UNION)\b/.test(t)) return "categorical";
  if (t === "BOOLEAN" || t === "BOOL") return "boolean";
  if (/^(DATE|TIMESTAMP)/.test(t)) return "temporal";
  if (/^(U?TINYINT|U?SMALLINT|U?INTEGER|U?INT\d*|U?BIGINT|U?HUGEINT|FLOAT|REAL|DOUBLE|DECIMAL|NUMERIC)\b/.test(t)) return "numeric";
  return "categorical";
}

/** DuckDB quotes identifiers with double quotes and doubles the quote inside. */
export const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;

const CHART_TYPES = new Set<OmbChartSpec["type"]>(["bar", "line", "area", "scatter", "histogram", "pie", "heatmap"]);
const AGGS = new Set<NonNullable<OmbChartSpec["agg"]>>(["count", "sum", "avg", "min", "max", "median"]);
const SORTS = new Set<NonNullable<OmbChartSpec["sort"]>>(["x", "-x", "y", "-y"]);
const TIME_UNITS: Record<NonNullable<OmbChartSpec["timeUnit"]>, string> = {
  hour: "INTERVAL 1 HOUR",
  day: "INTERVAL 1 DAY",
  week: "INTERVAL 1 WEEK",
  month: "INTERVAL 1 MONTH",
  quarter: "INTERVAL 3 MONTH",
  year: "INTERVAL 1 YEAR",
};

/** `from` is a bare or qualified (optionally quoted) table name, or a
 * parenthesised subquery. Anything else is refused before it reaches SQL. */
const IDENTIFIER = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const FROM_TARGET = new RegExp(`^(?:\\([\\s\\S]+\\)|${IDENTIFIER}(?:\\.${IDENTIFIER}){0,2})$`);

function fail(message: string, extra: { hint?: string; candidates?: string[] } = {}): never {
  throw new DataFailure({ code: "spec_invalid", message, ...extra });
}

/** Columns most like a misspelt name, closest first: same letters in another
 * case, then a containing or contained name, then a shared initial. */
function candidatesFor(name: string, columns: DataColumn[]): string[] {
  const needle = name.toLowerCase();
  const score = (c: string): number => {
    const h = c.toLowerCase();
    return h === needle ? 0 : h.includes(needle) || needle.includes(h) ? 1 : h[0] === needle[0] ? 2 : 3;
  };
  return columns.map((c) => c.name).sort((a, b) => score(a) - score(b) || a.localeCompare(b)).slice(0, 8);
}

interface Resolved {
  column: DataColumn;
  cls: ColumnClass;
  /** The quoted identifier, ready for SQL. */
  id: string;
}

function resolve(role: string, name: unknown, columns: DataColumn[]): Resolved {
  if (typeof name !== "string" || name.length === 0) fail(`${role} must name a column`);
  const column = columns.find((c) => c.name === name);
  if (!column) {
    const candidates = candidatesFor(name, columns);
    fail(`Column "${name}" (${role}) is not in the result`, {
      hint: candidates.length ? `Columns: ${candidates.join(", ")}` : "The result has no columns",
      candidates,
    });
  }
  return { column, cls: columnClass(column.type), id: quoteIdentifier(column.name) };
}

type Encoding = Record<string, unknown>;
type Reduction = CompiledChart["reduction"];
type VegaType = "quantitative" | "temporal" | "nominal";

const vegaType = (c: Resolved): VegaType => (c.cls === "numeric" ? "quantitative" : c.cls === "temporal" ? "temporal" : "nominal");

interface Cte {
  name: string;
  /** The parenthesised body. */
  body: string;
}

/** One dimension of a chart: how SQL produces it, how Vega-Lite reads it. */
interface Dimension {
  /** The channel's SQL expression. */
  expr: string;
  /** The band end (bins and bucketed bars): its channel and expression. */
  end?: { channel: string; expr: string };
  /** A CTE the expression reads (the range of the column), or none. */
  cte?: Cte;
  /** The Vega-Lite field defs for the channel and its band end. */
  encoding: Encoding;
  endEncoding?: Encoding;
  tooltip: Encoding[];
  reduction: Reduction;
}

/** Categories as text. NULL stays NULL here and folds into "other" later. */
function categorical(x: Resolved, channel: string, spec: OmbChartSpec): Dimension {
  const sort = spec.sort === "-x" ? "descending" : spec.sort === "y" || spec.sort === "-y" ? spec.sort : undefined;
  return {
    expr: `CAST(${x.id} AS VARCHAR)`,
    encoding: { field: channel, type: "nominal", title: x.column.name, ...(sort ? { sort } : {}) },
    tooltip: [{ field: channel, type: "nominal", title: x.column.name }],
    reduction: { method: "group", note: `grouped by ${x.column.name}` },
  };
}

/** Equal-width bins over the column's range; the last bin takes the maximum.
 * A constant column gets one bin of width 1 so the bar still shows. */
function binned(x: Resolved, channel: string, bins: number, bars: boolean): Dimension {
  const v = `CAST(${x.id} AS DOUBLE)`;
  const cte: Cte = {
    name: `bins_${channel}`,
    body: `
  SELECT min(${v}) AS lo,
         CASE WHEN max(${v}) = min(${v}) THEN 1 ELSE (max(${v}) - min(${v})) / ${bins} END AS width
  FROM src
`,
  };
  const bin = `least(floor((${v} - ${cte.name}.lo) / ${cte.name}.width), ${bins - 1})`;
  const start = `${cte.name}.lo + ${bin} * ${cte.name}.width`;
  const end = `${channel}2`;
  // Bars span the bin; a line sits on its centre.
  return bars
    ? {
        expr: start,
        end: { channel: end, expr: `${cte.name}.lo + (${bin} + 1) * ${cte.name}.width` },
        cte,
        encoding: { field: channel, type: "quantitative", title: x.column.name, bin: "binned" },
        endEncoding: { field: end },
        tooltip: [
          { field: channel, type: "quantitative", title: `${x.column.name} from`, format: ".4~g" },
          { field: end, type: "quantitative", title: "to", format: ".4~g" },
        ],
        reduction: { method: "bins", note: `${bins} equal-width bins of ${x.column.name}` },
      }
    : {
        expr: `${start} + ${cte.name}.width / 2`,
        cte,
        encoding: { field: channel, type: "quantitative", title: x.column.name },
        tooltip: [{ field: channel, type: "quantitative", title: x.column.name, format: ".4~g" }],
        reduction: { method: "bins", note: `${bins} equal-width bins of ${x.column.name}` },
      };
}

/** `time_bucket` with the unit from the spec, or chosen in SQL from the
 * data's range: the coarsest of hour/day/week/month/quarter/year that keeps
 * the axis under TIME_BUCKETS_TARGET buckets. A DATE never buckets by hour. */
function timeBucketed(x: Resolved, channel: string, spec: OmbChartSpec, bars: boolean): Dimension {
  const isDate = x.column.type.trim().toUpperCase() === "DATE";
  let unit: string;
  let cte: Cte | undefined;
  if (spec.timeUnit) {
    unit = TIME_UNITS[spec.timeUnit];
  } else {
    cte = { name: `span_${channel}`, body: "" };
    unit = `${cte.name}.unit`;
    const seconds = `epoch(max(CAST(${x.id} AS TIMESTAMP)) - min(CAST(${x.id} AS TIMESTAMP)))`;
    const steps: Array<[string, number]> = [
      ["INTERVAL 1 HOUR", 3600],
      ["INTERVAL 1 DAY", 86400],
      ["INTERVAL 1 WEEK", 604800],
      ["INTERVAL 1 MONTH", 2629800],
      ["INTERVAL 3 MONTH", 7889400],
    ];
    const whens = steps
      .filter(([interval]) => !(isDate && interval === "INTERVAL 1 HOUR"))
      .map(([interval, s]) => `    WHEN ${seconds} <= ${TIME_BUCKETS_TARGET * s} THEN ${interval}`)
      .join("\n");
    cte.body = `
  SELECT CASE
${whens}
    ELSE INTERVAL 1 YEAR END AS unit
  FROM src
`;
  }
  const bucket = `time_bucket(${unit}, ${x.id})`;
  const end = `${channel}2`;
  const unitNote = spec.timeUnit ? `by ${spec.timeUnit}` : `by hour, day, week, month, quarter or year, whichever keeps under ${TIME_BUCKETS_TARGET} buckets`;
  return {
    expr: bucket,
    ...(bars ? { end: { channel: end, expr: `${bucket} + ${unit}` }, endEncoding: { field: end } } : {}),
    cte,
    encoding: { field: channel, type: "temporal", title: x.column.name },
    tooltip: [{ field: channel, type: "temporal", title: x.column.name }],
    reduction: { method: "timeBucket", note: `${x.column.name} bucketed ${unitNote}` },
  };
}

function dimension(x: Resolved, channel: string, spec: OmbChartSpec, bars: boolean): Dimension {
  if (x.cls === "numeric") return binned(x, channel, spec.bins ?? BINS_DEFAULT, bars);
  if (x.cls === "temporal") return timeBucketed(x, channel, spec, bars);
  return categorical(x, channel, spec);
}

interface Measure {
  expr: string;
  title: string;
  type: VegaType;
}

/** The aggregate per group: count by default, sum when y is named. Sums,
 * averages and medians of text are refused here rather than by DuckDB, so
 * the bot reads one clear reason. */
function measure(spec: OmbChartSpec, y: Resolved | undefined): Measure {
  const agg = spec.agg ?? (y ? "sum" : "count");
  if (agg === "count") {
    return y
      ? { expr: `count(${y.id})`, title: `count of ${y.column.name}`, type: "quantitative" }
      : { expr: "count(*)", title: "count", type: "quantitative" };
  }
  if (!y) fail(`agg "${agg}" needs y`, { hint: "Name the column to aggregate in y, or drop agg to count rows" });
  if (agg === "min" || agg === "max") {
    if (y.cls !== "numeric" && y.cls !== "temporal") {
      fail(`agg "${agg}" needs a numeric or date y; "${y.column.name}" is ${y.column.type}`, { hint: "Use count, or pick a numeric or date column" });
    }
    return { expr: `${agg}(${y.id})`, title: `${agg}(${y.column.name})`, type: vegaType(y) };
  }
  if (y.cls !== "numeric") {
    fail(`agg "${agg}" needs a numeric y; "${y.column.name}" is ${y.column.type}`, { hint: "Use count, min or max, or pick a numeric column" });
  }
  return { expr: `${agg}(${y.id})`, title: `${agg}(${y.column.name})`, type: "quantitative" };
}

function colorEncoding(color: Resolved): Encoding {
  return { field: "color", type: vegaType(color), title: color.column.name };
}

/** What a chart type compiles to before the source is known. */
interface Plan {
  ctes: Cte[];
  /** SELECT … FROM … GROUP BY … ORDER BY …, without the LIMIT. */
  body: string;
  vegaLite: Record<string, unknown>;
  reduction: Reduction;
}

function vegaLiteSpec(mark: string, encoding: Encoding, tooltip: Encoding[]): Record<string, unknown> {
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    width: "container",
    height: 280,
    data: { name: "table" },
    mark: { type: mark },
    encoding: { ...encoding, tooltip },
  };
}

const money = ",.4~g";

function checkSpec(spec: OmbChartSpec): void {
  if (!spec || typeof spec !== "object") fail("chart must be an object");
  if (!CHART_TYPES.has(spec.type)) fail(`chart.type must be one of ${[...CHART_TYPES].join(", ")}`);
  if (spec.agg !== undefined && !AGGS.has(spec.agg)) fail(`chart.agg must be one of ${[...AGGS].join(", ")}`);
  if (spec.sort !== undefined && !SORTS.has(spec.sort)) fail(`chart.sort must be one of ${[...SORTS].join(", ")}`);
  if (spec.timeUnit !== undefined && !(spec.timeUnit in TIME_UNITS)) fail(`chart.timeUnit must be one of ${Object.keys(TIME_UNITS).join(", ")}`);
  for (const key of ["limit", "bins"] as const) {
    const value = spec[key];
    if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > DATA_LIMITS.chartMaxMarks)) {
      fail(`chart.${key} must be a whole number from 1 to ${DATA_LIMITS.chartMaxMarks}`);
    }
  }
  if (spec.stack !== undefined && typeof spec.stack !== "boolean") fail("chart.stack must be true or false");
}

/** Bars, lines, areas and histograms: one dimension on x, an aggregate on
 * y, an optional series. A categorical x folds to the top N; a numeric x
 * bins; a temporal x buckets — or, for a line/area of a raw numeric y with
 * neither agg nor timeUnit, M4-downsamples instead of aggregating. */
function planCartesian(spec: OmbChartSpec, x: Resolved, y: Resolved | undefined, color: Resolved | undefined): Plan {
  const bars = spec.type === "bar" || spec.type === "histogram";
  const mark = bars ? "bar" : spec.type;

  if (!bars && x.cls === "temporal" && y && y.cls === "numeric" && !spec.agg && !spec.timeUnit) {
    return planM4(x, y, color, mark);
  }

  const m = measure(spec, y);
  const dim = dimension(x, "x", spec, bars);
  const ctes: Cte[] = dim.cte ? [dim.cte] : [];
  let xExpr = dim.expr;
  let reduction = dim.reduction;
  if (x.cls === "categorical" || x.cls === "boolean") {
    // Top N by the measure, the rest (and NULL) as "other". `IN (subquery)`
    // is NULL for a NULL category, so NULL lands in "other" with the tail.
    const n = spec.limit ?? TOP_N_DEFAULT;
    ctes.push({
      name: "kept",
      body: `
  SELECT ${xExpr} AS x
  FROM src
  GROUP BY ALL
  ORDER BY ${m.expr} DESC NULLS LAST, x
  LIMIT ${n}
`,
    });
    xExpr = `CASE WHEN ${xExpr} IN (SELECT x FROM kept) THEN ${xExpr} ELSE 'other' END`;
    reduction = { method: "topN", note: `top ${n} of ${x.column.name} by ${m.title}, the rest as "other"` };
  }

  const selects = [`${xExpr} AS x`];
  if (dim.end) selects.push(`${dim.end.expr} AS ${dim.end.channel}`);
  if (color) selects.push(`CAST(${color.id} AS VARCHAR) AS color`);
  selects.push(`${m.expr} AS y`);
  const from = dim.cte ? `src, ${dim.cte.name}` : "src";
  const orderBy = spec.sort === "-y" ? "y DESC" : spec.sort === "y" ? "y" : spec.sort === "-x" ? "x DESC" : "x";
  const body = `SELECT ${selects.join(",\n       ")}\nFROM ${from}\nGROUP BY ALL\nORDER BY ${orderBy}`;

  const yEncoding: Encoding = { field: "y", type: m.type, title: m.title };
  const encoding: Encoding = { x: dim.encoding, y: yEncoding };
  if (dim.endEncoding) encoding.x2 = dim.endEncoding;
  const tooltip: Encoding[] = [...dim.tooltip];
  if (color) {
    encoding.color = { field: "color", type: "nominal", title: color.column.name };
    tooltip.push({ field: "color", type: "nominal", title: color.column.name });
    if (spec.stack === false) {
      yEncoding.stack = null;
      // Grouped bars need a discrete x; binned or bucketed bars overlap, so fade them.
      if (bars && (x.cls === "categorical" || x.cls === "boolean")) encoding.xOffset = { field: "color" };
      else if (mark !== "line") encoding.opacity = { value: 0.6 };
    }
    reduction = { ...reduction, note: `${reduction.note}, by ${color.column.name}` };
  }
  tooltip.push({ field: "y", type: m.type, title: m.title, ...(m.type === "quantitative" ? { format: money } : {}) });
  return { ctes, body, vegaLite: vegaLiteSpec(mark, encoding, tooltip), reduction };
}

/** M4 (Jugel et al., VLDB 2014): per pixel column keep the first, last,
 * lowest and highest point. At most 4·M4_WIDTH rows per series, and the
 * line drawn at that width is identical to the one from every row. */
function planM4(x: Resolved, y: Resolved, color: Resolved | undefined, mark: string): Plan {
  const t = `epoch_ms(CAST(${x.id} AS TIMESTAMP))`;
  const partition = color ? "px, color" : "px";
  const selects = [`${x.id} AS x`, `CAST(${y.id} AS DOUBLE) AS y`];
  if (color) selects.push(`CAST(${color.id} AS VARCHAR) AS color`);
  const ctes: Cte[] = [
    {
      name: "span",
      body: `
  SELECT min(${t}) AS t0, max(${t}) AS t1
  FROM src
  WHERE ${x.id} IS NOT NULL AND ${y.id} IS NOT NULL
`,
    },
    {
      name: "px",
      body: `
  SELECT least(floor(${M4_WIDTH} * (${t} - span.t0) / greatest(span.t1 - span.t0, 1)), ${M4_WIDTH - 1}) AS px,
         ${selects.join(",\n         ")}
  FROM src, span
  WHERE ${x.id} IS NOT NULL AND ${y.id} IS NOT NULL
`,
    },
  ];
  const windows = ["ORDER BY x", "ORDER BY x DESC", "ORDER BY y, x", "ORDER BY y DESC, x"]
    .map((order) => `row_number() OVER (PARTITION BY ${partition} ${order}) = 1`)
    .join("\n     OR ");
  const body = `SELECT x, y${color ? ", color" : ""}\nFROM px\nQUALIFY ${windows}\nORDER BY ${color ? "color, x" : "x"}`;

  const encoding: Encoding = {
    x: { field: "x", type: "temporal", title: x.column.name },
    y: { field: "y", type: "quantitative", title: y.column.name, ...(mark === "area" ? { stack: null } : {}) },
  };
  const tooltip: Encoding[] = [
    { field: "x", type: "temporal", title: x.column.name },
    { field: "y", type: "quantitative", title: y.column.name, format: money },
  ];
  if (color) {
    encoding.color = colorEncoding(color);
    tooltip.push({ field: "color", type: "nominal", title: color.column.name });
  }
  return {
    ctes,
    body,
    vegaLite: vegaLiteSpec(mark, encoding, tooltip),
    reduction: { method: "m4", note: `M4: first, last, lowest and highest ${y.column.name} per pixel column at ${M4_WIDTH} px${color ? `, by ${color.column.name}` : ""}` },
  };
}

/** Slices are categories whatever the column's type; the top N by the measure. */
function planPie(spec: OmbChartSpec, x: Resolved, y: Resolved | undefined): Plan {
  const m = measure(spec, y);
  const n = spec.limit ?? TOP_N_DEFAULT;
  const xExpr = `CAST(${x.id} AS VARCHAR)`;
  const ctes: Cte[] = [
    {
      name: "kept",
      body: `
  SELECT ${xExpr} AS x
  FROM src
  GROUP BY ALL
  ORDER BY ${m.expr} DESC NULLS LAST, x
  LIMIT ${n}
`,
    },
  ];
  const folded = `CASE WHEN ${xExpr} IN (SELECT x FROM kept) THEN ${xExpr} ELSE 'other' END`;
  const orderBy = spec.sort === "y" ? "y" : spec.sort === "-x" ? "x DESC" : spec.sort === "x" ? "x" : "y DESC";
  const body = `SELECT ${folded} AS x,\n       ${m.expr} AS y\nFROM src\nGROUP BY ALL\nORDER BY ${orderBy}`;
  const encoding: Encoding = {
    theta: { field: "y", type: "quantitative", title: m.title },
    color: { field: "x", type: "nominal", title: x.column.name },
    // Slices in the order of their size; "other" sits where its total puts it.
    order: { field: "y", type: "quantitative", sort: spec.sort === "y" ? "ascending" : "descending" },
  };
  const tooltip: Encoding[] = [
    { field: "x", type: "nominal", title: x.column.name },
    { field: "y", type: "quantitative", title: m.title, format: money },
  ];
  return { ctes, body, vegaLite: vegaLiteSpec("arc", encoding, tooltip), reduction: { method: "topN", note: `top ${n} of ${x.column.name} by ${m.title}, the rest as "other"` } };
}

/** Points straight from the source through a repeatable reservoir sample of
 * chartMaxMarks rows. The sample is the whole table when the table is
 * smaller, so the caller may report "none" when input and output counts match. */
function planScatter(x: Resolved, y: Resolved | undefined, color: Resolved | undefined, size: Resolved | undefined): Plan {
  if (!y) fail("scatter needs y", { hint: "Name the column for the y axis" });
  if (size && size.cls !== "numeric") fail(`size needs a numeric column; "${size.column.name}" is ${size.column.type}`);
  const selects = [`${x.id} AS x`, `${y.id} AS y`];
  if (color) selects.push(`${color.id} AS color`);
  if (size) selects.push(`${size.id} AS size`);
  const body = `SELECT ${selects.join(",\n       ")}\nFROM src USING SAMPLE reservoir(${DATA_LIMITS.chartMaxMarks} ROWS) REPEATABLE (${SAMPLE_SEED})`;
  const encoding: Encoding = {
    x: { field: "x", type: vegaType(x), title: x.column.name },
    y: { field: "y", type: vegaType(y), title: y.column.name },
  };
  const tooltip: Encoding[] = [
    { field: "x", type: vegaType(x), title: x.column.name },
    { field: "y", type: vegaType(y), title: y.column.name },
  ];
  if (color) {
    encoding.color = colorEncoding(color);
    tooltip.push({ field: "color", type: vegaType(color), title: color.column.name });
  }
  if (size) {
    encoding.size = { field: "size", type: "quantitative", title: size.column.name };
    tooltip.push({ field: "size", type: "quantitative", title: size.column.name });
  }
  return {
    ctes: [],
    body,
    vegaLite: vegaLiteSpec("point", encoding, tooltip),
    reduction: { method: "sample", note: `reservoir sample of up to ${DATA_LIMITS.chartMaxMarks.toLocaleString("en-US")} rows (seed ${SAMPLE_SEED})` },
  };
}

/** Two dimensions (x, and the spec's `color` on the y axis) with the
 * measure as the cell colour. Numeric dimensions bin, temporal ones bucket,
 * categories stand as they are: the LIMIT catches two wide columns. */
function planHeatmap(spec: OmbChartSpec, x: Resolved, y: Resolved | undefined, color: Resolved | undefined): Plan {
  if (!color) fail("heatmap needs color: the column for the second axis", { hint: "x and color are the two axes; y (or count) colours the cells" });
  const m = measure(spec, y);
  const unsorted = { ...spec, sort: undefined };
  const dx = dimension(x, "x", unsorted, true);
  const dy = dimension(color, "y", unsorted, true);
  const ctes: Cte[] = [dx.cte, dy.cte].filter((c): c is Cte => c !== undefined);
  const selects = [`${dx.expr} AS x`];
  if (dx.end) selects.push(`${dx.end.expr} AS ${dx.end.channel}`);
  selects.push(`${dy.expr} AS y`);
  if (dy.end) selects.push(`${dy.end.expr} AS ${dy.end.channel}`);
  selects.push(`${m.expr} AS color`);
  const from = ["src", ...ctes.map((c) => c.name)].join(", ");
  const body = `SELECT ${selects.join(",\n       ")}\nFROM ${from}\nGROUP BY ALL\nORDER BY x, y`;
  const encoding: Encoding = { x: dx.encoding, y: dy.encoding, color: { field: "color", type: m.type, title: m.title } };
  if (dx.endEncoding) encoding.x2 = dx.endEncoding;
  if (dy.endEncoding) encoding.y2 = dy.endEncoding;
  const tooltip: Encoding[] = [...dx.tooltip, ...dy.tooltip, { field: "color", type: m.type, title: m.title, ...(m.type === "quantitative" ? { format: money } : {}) }];
  return {
    ctes,
    body,
    vegaLite: vegaLiteSpec("rect", encoding, tooltip),
    reduction: { method: "group", note: `${m.title} by ${x.column.name} and ${color.column.name}` },
  };
}

export const compileChart: ChartCompiler = (spec, columns, from) => {
  checkSpec(spec);
  const source = typeof from === "string" ? from.trim() : "";
  if (!FROM_TARGET.test(source)) {
    throw new DataFailure({ code: "invalid_input", message: "from must be a table name or a parenthesised subquery" });
  }
  const x = resolve("x", spec.x, columns);
  const y = spec.y === undefined ? undefined : resolve("y", spec.y, columns);
  const color = spec.color === undefined ? undefined : resolve("color", spec.color, columns);
  const size = spec.size === undefined ? undefined : resolve("size", spec.size, columns);
  if (size && spec.type !== "scatter") fail(`size applies to scatter only, not ${spec.type}`);
  if (spec.type === "pie" && color) fail("pie takes x (slices) and y (size) only; drop color", { hint: "For a series per colour use bar" });

  let plan: Plan;
  switch (spec.type) {
    case "pie":
      plan = planPie(spec, x, y);
      break;
    case "scatter":
      plan = planScatter(x, y, color, size);
      break;
    case "heatmap":
      plan = planHeatmap(spec, x, y, color);
      break;
    default:
      plan = planCartesian(spec, x, y, color);
  }
  // The source is the one piece of text here the compiler did not write
  // itself, and it enters the statement exactly once, as the first CTE.
  const ctes = [{ name: "src", body: `SELECT * FROM ${source}` }, ...plan.ctes].map((c) => `${c.name} AS (${c.body})`);
  const sql = `WITH ${ctes.join(",\n")}\n${plan.body}\nLIMIT ${CHART_SQL_LIMIT}`;
  return { sql, vegaLite: plan.vegaLite, reduction: plan.reduction };
};
