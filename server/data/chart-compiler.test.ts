import { describe, expect, it } from "vitest";

import { DATA_LIMITS, type DataColumn, type OmbChartSpec } from "../../shared/data-surface.ts";
import { CHART_SQL_LIMIT, columnClass, compileChart, quoteIdentifier } from "./chart-compiler.ts";
import { DataFailure } from "./types.ts";

const columns: DataColumn[] = [
  { name: "id", type: "BIGINT" },
  { name: "region", type: "VARCHAR" },
  { name: "channel", type: "VARCHAR" },
  { name: "paid", type: "BOOLEAN" },
  { name: "amount", type: "DECIMAL(10,2)" },
  { name: "qty", type: "INTEGER" },
  { name: "d", type: "DATE" },
  { name: "ts", type: "TIMESTAMP" },
  { name: "order", type: "VARCHAR" },
  { name: 'we"ird', type: "DOUBLE" },
];

const norm = (sql: string): string => sql.replace(/\s+/g, " ").trim();
const compile = (spec: OmbChartSpec, from = "sales") => compileChart(spec, columns, from);
const enc = (vl: Record<string, unknown>): Record<string, Record<string, unknown>> => vl.encoding as Record<string, Record<string, unknown>>;
const mark = (vl: Record<string, unknown>): string => (vl.mark as { type: string }).type;

function failure(fn: () => unknown): DataFailure {
  try {
    fn();
  } catch (error) {
    if (error instanceof DataFailure) return error;
    throw error;
  }
  throw new Error("expected a DataFailure");
}

describe("columnClass", () => {
  it.each([
    ["BIGINT", "numeric"],
    ["HUGEINT", "numeric"],
    ["UTINYINT", "numeric"],
    ["INTEGER", "numeric"],
    ["INT", "numeric"],
    ["DECIMAL(18,3)", "numeric"],
    ["DOUBLE", "numeric"],
    ["FLOAT", "numeric"],
    ["DATE", "temporal"],
    ["TIMESTAMP", "temporal"],
    ["TIMESTAMP WITH TIME ZONE", "temporal"],
    ["TIMESTAMP_NS", "temporal"],
    ["BOOLEAN", "boolean"],
    ["VARCHAR", "categorical"],
    ["UUID", "categorical"],
    ["TIME", "categorical"],
    ["INTERVAL", "categorical"],
    ["DOUBLE[]", "categorical"],
    ["STRUCT(a INTEGER)", "categorical"],
    ["ENUM('a', 'b')", "categorical"],
  ])("%s → %s", (type, cls) => {
    expect(columnClass(type)).toBe(cls);
  });
});

describe("compileChart: reductions per chart type and column class", () => {
  const cases: Array<{ name: string; spec: OmbChartSpec; method: string; sql: string[]; notSql?: string[]; check: (vl: Record<string, unknown>) => void }> = [
    {
      name: "bar over a category folds to the top N",
      spec: { type: "bar", x: "region", y: "amount" },
      method: "topN",
      sql: [
        'kept AS ( SELECT CAST("region" AS VARCHAR) AS x FROM src GROUP BY ALL ORDER BY sum("amount") DESC NULLS LAST, x LIMIT 20 )',
        `CASE WHEN CAST("region" AS VARCHAR) IN (SELECT x FROM kept) THEN CAST("region" AS VARCHAR) ELSE 'other' END AS x`,
        'sum("amount") AS y FROM src GROUP BY ALL ORDER BY x',
      ],
      check: (vl) => {
        expect(mark(vl)).toBe("bar");
        expect(enc(vl).x).toMatchObject({ field: "x", type: "nominal", title: "region" });
        expect(enc(vl).y).toMatchObject({ field: "y", type: "quantitative", title: "sum(amount)" });
        expect(enc(vl).x2).toBeUndefined();
      },
    },
    {
      name: "bar over a boolean folds too, counting rows by default",
      spec: { type: "bar", x: "paid" },
      method: "topN",
      sql: ['CAST("paid" AS VARCHAR)', "count(*) AS y", "ORDER BY count(*) DESC NULLS LAST, x LIMIT 20"],
      check: (vl) => expect(enc(vl).y).toMatchObject({ title: "count" }),
    },
    {
      name: "bar with a series groups by colour as well",
      spec: { type: "bar", x: "region", y: "amount", color: "channel" },
      method: "topN",
      sql: ['CAST("channel" AS VARCHAR) AS color, sum("amount") AS y FROM src GROUP BY ALL'],
      check: (vl) => {
        expect(enc(vl).color).toMatchObject({ field: "color", type: "nominal", title: "channel" });
        expect(enc(vl).y.stack).toBeUndefined();
      },
    },
    {
      name: "bar over a number bins it with a band end",
      spec: { type: "bar", x: "amount", y: "qty" },
      method: "bins",
      sql: [
        'bins_x AS ( SELECT min(CAST("amount" AS DOUBLE)) AS lo, CASE WHEN max(CAST("amount" AS DOUBLE)) = min(CAST("amount" AS DOUBLE)) THEN 1 ELSE (max(CAST("amount" AS DOUBLE)) - min(CAST("amount" AS DOUBLE))) / 30 END AS width FROM src )',
        'bins_x.lo + least(floor((CAST("amount" AS DOUBLE) - bins_x.lo) / bins_x.width), 29) * bins_x.width AS x',
        "+ 1) * bins_x.width AS x2",
        'sum("qty") AS y FROM src, bins_x GROUP BY ALL ORDER BY x',
      ],
      check: (vl) => {
        expect(enc(vl).x).toMatchObject({ field: "x", type: "quantitative", bin: "binned", title: "amount" });
        expect(enc(vl).x2).toEqual({ field: "x2" });
      },
    },
    {
      name: "bar over a timestamp buckets with the unit chosen from the range",
      spec: { type: "bar", x: "ts" },
      method: "timeBucket",
      sql: [
        "span_x AS ( SELECT CASE WHEN epoch(max(CAST(\"ts\" AS TIMESTAMP)) - min(CAST(\"ts\" AS TIMESTAMP))) <= 1800000 THEN INTERVAL 1 HOUR",
        "<= 43200000 THEN INTERVAL 1 DAY",
        "<= 302400000 THEN INTERVAL 1 WEEK",
        "<= 1314900000 THEN INTERVAL 1 MONTH",
        "<= 3944700000 THEN INTERVAL 3 MONTH ELSE INTERVAL 1 YEAR END AS unit FROM src )",
        'time_bucket(span_x.unit, "ts") AS x, time_bucket(span_x.unit, "ts") + span_x.unit AS x2, count(*) AS y FROM src, span_x GROUP BY ALL',
      ],
      check: (vl) => {
        expect(enc(vl).x).toMatchObject({ field: "x", type: "temporal", title: "ts" });
        expect(enc(vl).x2).toEqual({ field: "x2" });
      },
    },
    {
      name: "a DATE never buckets by hour",
      spec: { type: "bar", x: "d" },
      method: "timeBucket",
      sql: ["<= 43200000 THEN INTERVAL 1 DAY"],
      notSql: ["INTERVAL 1 HOUR"],
      check: (vl) => expect(enc(vl).x.type).toBe("temporal"),
    },
    {
      name: "a named timeUnit is a literal interval and needs no range",
      spec: { type: "bar", x: "ts", timeUnit: "week" },
      method: "timeBucket",
      sql: ['time_bucket(INTERVAL 1 WEEK, "ts") AS x, time_bucket(INTERVAL 1 WEEK, "ts") + INTERVAL 1 WEEK AS x2'],
      notSql: ["span_x"],
      check: (vl) => expect(enc(vl).x.type).toBe("temporal"),
    },
    {
      name: "quarter is three months",
      spec: { type: "line", x: "d", y: "amount", timeUnit: "quarter" },
      method: "timeBucket",
      sql: ['time_bucket(INTERVAL 3 MONTH, "d") AS x, sum("amount") AS y'],
      check: (vl) => expect(mark(vl)).toBe("line"),
    },
    {
      name: "line of an aggregate over time buckets without a band end",
      spec: { type: "line", x: "ts", y: "amount", agg: "avg", color: "channel" },
      method: "timeBucket",
      sql: ['time_bucket(span_x.unit, "ts") AS x, CAST("channel" AS VARCHAR) AS color, avg("amount") AS y'],
      notSql: ["AS x2"],
      check: (vl) => {
        expect(mark(vl)).toBe("line");
        expect(enc(vl).x2).toBeUndefined();
        expect(enc(vl).y.title).toBe("avg(amount)");
      },
    },
    {
      name: "line of a raw number over time is M4-downsampled",
      spec: { type: "line", x: "ts", y: "amount" },
      method: "m4",
      sql: [
        'span AS ( SELECT min(epoch_ms(CAST("ts" AS TIMESTAMP))) AS t0, max(epoch_ms(CAST("ts" AS TIMESTAMP))) AS t1 FROM src WHERE "ts" IS NOT NULL AND "amount" IS NOT NULL )',
        'least(floor(800 * (epoch_ms(CAST("ts" AS TIMESTAMP)) - span.t0) / greatest(span.t1 - span.t0, 1)), 799) AS px',
        "QUALIFY row_number() OVER (PARTITION BY px ORDER BY x) = 1 OR row_number() OVER (PARTITION BY px ORDER BY x DESC) = 1 OR row_number() OVER (PARTITION BY px ORDER BY y, x) = 1 OR row_number() OVER (PARTITION BY px ORDER BY y DESC, x) = 1 ORDER BY x",
      ],
      notSql: ["GROUP BY"],
      check: (vl) => {
        expect(enc(vl).x).toMatchObject({ type: "temporal" });
        expect(enc(vl).y).toMatchObject({ type: "quantitative", title: "amount" });
      },
    },
    {
      name: "M4 with a series keeps four points per pixel column per series",
      spec: { type: "area", x: "ts", y: "amount", color: "channel" },
      method: "m4",
      sql: ["PARTITION BY px, color ORDER BY x", "ORDER BY color, x"],
      check: (vl) => {
        expect(mark(vl)).toBe("area");
        expect(enc(vl).y.stack).toBeNull();
        expect(enc(vl).color).toMatchObject({ field: "color", type: "nominal" });
      },
    },
    {
      name: "line over a number bins to the bin centre",
      spec: { type: "line", x: "qty", y: "amount" },
      method: "bins",
      sql: ["* bins_x.width + bins_x.width / 2 AS x"],
      notSql: ["AS x2"],
      check: (vl) => {
        expect(enc(vl).x).toMatchObject({ type: "quantitative" });
        expect(enc(vl).x.bin).toBeUndefined();
      },
    },
    {
      name: "area over a category folds like a bar",
      spec: { type: "area", x: "region", y: "amount" },
      method: "topN",
      sql: ["IN (SELECT x FROM kept)"],
      check: (vl) => expect(mark(vl)).toBe("area"),
    },
    {
      name: "histogram counts into 30 equal-width bins",
      spec: { type: "histogram", x: "amount" },
      method: "bins",
      sql: ["/ 30 END AS width", ", 29) * bins_x.width AS x", "count(*) AS y"],
      check: (vl) => {
        expect(mark(vl)).toBe("bar");
        expect(enc(vl).x).toMatchObject({ bin: "binned" });
        expect(enc(vl).y).toMatchObject({ title: "count" });
      },
    },
    {
      name: "histogram honours bins and an aggregate",
      spec: { type: "histogram", x: "amount", y: "qty", agg: "avg", bins: 10 },
      method: "bins",
      sql: ["/ 10 END AS width", ", 9) * bins_x.width AS x", 'avg("qty") AS y'],
      check: (vl) => expect(enc(vl).y.title).toBe("avg(qty)"),
    },
    {
      name: "scatter samples a repeatable reservoir",
      spec: { type: "scatter", x: "qty", y: "amount", color: "channel", size: 'we"ird' },
      method: "sample",
      sql: [`SELECT "qty" AS x, "amount" AS y, "channel" AS color, "we""ird" AS size FROM src USING SAMPLE reservoir(${DATA_LIMITS.chartMaxMarks} ROWS) REPEATABLE (42)`],
      notSql: ["GROUP BY"],
      check: (vl) => {
        expect(mark(vl)).toBe("point");
        expect(enc(vl).x).toMatchObject({ type: "quantitative", title: "qty" });
        expect(enc(vl).color).toMatchObject({ type: "nominal", title: "channel" });
        expect(enc(vl).size).toMatchObject({ field: "size", type: "quantitative", title: 'we"ird' });
      },
    },
    {
      name: "scatter over time keeps x temporal",
      spec: { type: "scatter", x: "ts", y: "amount" },
      method: "sample",
      sql: ['"ts" AS x'],
      check: (vl) => expect(enc(vl).x.type).toBe("temporal"),
    },
    {
      name: "pie slices are the top N categories by the measure",
      spec: { type: "pie", x: "channel", y: "amount" },
      method: "topN",
      sql: ["LIMIT 20 )", "ELSE 'other' END AS x", 'sum("amount") AS y FROM src GROUP BY ALL ORDER BY y DESC'],
      check: (vl) => {
        expect(mark(vl)).toBe("arc");
        expect(enc(vl).theta).toMatchObject({ field: "y", type: "quantitative" });
        expect(enc(vl).color).toMatchObject({ field: "x", type: "nominal", title: "channel" });
      },
    },
    {
      name: "pie treats a numeric x as categories",
      spec: { type: "pie", x: "qty" },
      method: "topN",
      sql: ['CAST("qty" AS VARCHAR)'],
      check: (vl) => expect(mark(vl)).toBe("arc"),
    },
    {
      name: "heatmap groups two categories and colours by the measure",
      spec: { type: "heatmap", x: "region", color: "channel" },
      method: "group",
      sql: ['SELECT CAST("region" AS VARCHAR) AS x, CAST("channel" AS VARCHAR) AS y, count(*) AS color FROM src GROUP BY ALL ORDER BY x, y'],
      notSql: ["kept"],
      check: (vl) => {
        expect(mark(vl)).toBe("rect");
        expect(enc(vl).x).toMatchObject({ field: "x", type: "nominal", title: "region" });
        expect(enc(vl).y).toMatchObject({ field: "y", type: "nominal", title: "channel" });
        expect(enc(vl).color).toMatchObject({ field: "color", type: "quantitative", title: "count" });
      },
    },
    {
      name: "heatmap bins both numeric axes and buckets a date axis",
      spec: { type: "heatmap", x: "amount", color: "d", y: "qty", agg: "avg", bins: 5 },
      method: "group",
      sql: ["bins_x AS (", "span_y AS (", 'time_bucket(span_y.unit, "d") AS y, time_bucket(span_y.unit, "d") + span_y.unit AS y2, avg("qty") AS color FROM src, bins_x, span_y'],
      check: (vl) => {
        expect(enc(vl).x).toMatchObject({ bin: "binned" });
        expect(enc(vl).x2).toEqual({ field: "x2" });
        expect(enc(vl).y).toMatchObject({ type: "temporal", title: "d" });
        expect(enc(vl).y2).toEqual({ field: "y2" });
      },
    },
  ];

  it.each(cases)("$name", ({ spec, method, sql, notSql, check }) => {
    const out = compile(spec);
    expect(out.reduction.method).toBe(method);
    const text = norm(out.sql);
    expect(text.startsWith("WITH src AS (SELECT * FROM sales)")).toBe(true);
    for (const piece of sql) expect(text).toContain(piece);
    for (const piece of notSql ?? []) expect(text).not.toContain(piece);
    check(out.vegaLite);
  });

  it("every statement ends with LIMIT chartMaxMarks + 1, the overflow sentinel", () => {
    expect(CHART_SQL_LIMIT).toBe(DATA_LIMITS.chartMaxMarks + 1);
    for (const { spec } of cases) {
      const { sql } = compile(spec);
      expect(sql.trimEnd().endsWith(`\nLIMIT ${CHART_SQL_LIMIT}`)).toBe(true);
      // One LIMIT at the end of the statement; the top-N CTE's own LIMIT is N.
      expect(sql.match(new RegExp(`LIMIT ${CHART_SQL_LIMIT}\\b`, "g"))).toHaveLength(1);
    }
  });

  it("every Vega-Lite spec is data-free, container-wide, 280 high, with tooltips", () => {
    for (const { spec } of cases) {
      const { vegaLite } = compile(spec);
      expect(vegaLite.$schema).toBe("https://vega.github.io/schema/vega-lite/v6.json");
      expect(vegaLite.data).toEqual({ name: "table" });
      expect(vegaLite.width).toBe("container");
      expect(vegaLite.height).toBe(280);
      const tooltip = enc(vegaLite).tooltip as unknown as Array<Record<string, unknown>>;
      expect(tooltip.length).toBeGreaterThanOrEqual(2);
      for (const t of tooltip) expect(t).toHaveProperty("title");
    }
  });
});

describe("compileChart: top-N folding", () => {
  it("keeps the spec's limit", () => {
    const { sql, reduction } = compile({ type: "bar", x: "region", y: "amount", limit: 5 });
    expect(norm(sql)).toContain("ORDER BY sum(\"amount\") DESC NULLS LAST, x LIMIT 5 )");
    expect(reduction.note).toContain("top 5 of region");
  });

  it("ranks categories by the chart's own measure", () => {
    const { sql } = compile({ type: "bar", x: "region", y: "amount", agg: "max" });
    expect(norm(sql)).toContain('ORDER BY max("amount") DESC NULLS LAST, x LIMIT 20 )');
  });

  it("does not fold numbers or dates", () => {
    for (const x of ["amount", "ts", "d"]) {
      const { sql } = compile({ type: "bar", x });
      expect(sql).not.toContain("kept");
      expect(sql).not.toContain("'other'");
    }
  });
});

describe("compileChart: sort and stack", () => {
  it("maps sort to the x encoding and to the SQL order", () => {
    expect(compile({ type: "bar", x: "region", sort: "-y" })).toMatchObject({ vegaLite: { encoding: { x: { sort: "-y" } } } });
    expect(norm(compile({ type: "bar", x: "region", sort: "-y" }).sql)).toContain("GROUP BY ALL ORDER BY y DESC LIMIT");
    expect(compile({ type: "bar", x: "region", sort: "-x" })).toMatchObject({ vegaLite: { encoding: { x: { sort: "descending" } } } });
    expect(norm(compile({ type: "bar", x: "region", sort: "y" }).sql)).toContain("GROUP BY ALL ORDER BY y LIMIT");
    expect(enc(compile({ type: "bar", x: "region" }).vegaLite).x.sort).toBeUndefined();
  });

  it("stack:false makes grouped bars for categories and faded bars for bins", () => {
    const grouped = enc(compile({ type: "bar", x: "region", y: "amount", color: "channel", stack: false }).vegaLite);
    expect(grouped.y.stack).toBeNull();
    expect(grouped.xOffset).toEqual({ field: "color" });
    const faded = enc(compile({ type: "bar", x: "amount", y: "qty", color: "channel", stack: false }).vegaLite);
    expect(faded.y.stack).toBeNull();
    expect(faded.xOffset).toBeUndefined();
    expect(faded.opacity).toEqual({ value: 0.6 });
  });
});

describe("compileChart: identifiers and the source", () => {
  it("double-quotes identifiers and doubles a quote inside", () => {
    expect(quoteIdentifier("order")).toBe('"order"');
    expect(quoteIdentifier('we"ird')).toBe('"we""ird"');
    const { sql, vegaLite } = compile({ type: "bar", x: "order", y: 'we"ird' });
    expect(sql).toContain('CAST("order" AS VARCHAR)');
    expect(sql).toContain('sum("we""ird") AS y');
    expect(enc(vegaLite).x.title).toBe("order");
    expect(enc(vegaLite).y.title).toBe('sum(we"ird)');
  });

  it("reads from a table, a qualified table, a quoted table or a subquery", () => {
    expect(compile({ type: "bar", x: "region" }, "omb_results.q_3").sql).toContain("src AS (SELECT * FROM omb_results.q_3)");
    expect(compile({ type: "bar", x: "region" }, '"my table"').sql).toContain('src AS (SELECT * FROM "my table")');
    expect(compile({ type: "bar", x: "region" }, "(SELECT * FROM sales WHERE qty > 1)").sql).toContain("src AS (SELECT * FROM (SELECT * FROM sales WHERE qty > 1))");
  });

  it("refuses a source that is neither", () => {
    for (const from of ["", "sales; DROP TABLE sales", "sales WHERE 1=1", "SELECT 1"]) {
      expect(failure(() => compile({ type: "bar", x: "region" }, from)).error.code).toBe("invalid_input");
    }
  });
});

describe("compileChart: spec_invalid", () => {
  it("names the missing column and offers candidates, closest first", () => {
    const error = failure(() => compile({ type: "bar", x: "Region" })).error;
    expect(error.code).toBe("spec_invalid");
    expect(error.message).toBe('Column "Region" (x) is not in the result');
    expect(error.candidates?.[0]).toBe("region");
    expect(error.hint).toContain("region");
    expect(failure(() => compile({ type: "bar", x: "region", y: "amt" })).error.candidates?.[0]).toBe("amount");
    expect(failure(() => compile({ type: "bar", x: "region", color: "chan" })).error.message).toContain("(color)");
  });

  it.each<[string, OmbChartSpec]>([
    ["an unknown type", { type: "radar" as never, x: "region" }],
    ["an unknown agg", { type: "bar", x: "region", y: "amount", agg: "mode" as never }],
    ["an unknown sort", { type: "bar", x: "region", sort: "up" as never }],
    ["an unknown timeUnit", { type: "bar", x: "ts", timeUnit: "fortnight" as never }],
    ["a zero limit", { type: "bar", x: "region", limit: 0 }],
    ["fractional bins", { type: "histogram", x: "amount", bins: 2.5 }],
    ["scatter without y", { type: "scatter", x: "qty" }],
    ["heatmap without color", { type: "heatmap", x: "region" }],
    ["pie with a colour", { type: "pie", x: "region", color: "channel" }],
    ["size on a bar", { type: "bar", x: "region", size: "qty" }],
    ["size from a text column", { type: "scatter", x: "qty", y: "amount", size: "region" }],
    ["a sum of text", { type: "bar", x: "region", y: "channel" }],
    ["an average of a date", { type: "bar", x: "region", y: "ts", agg: "avg" }],
    ["a max of text", { type: "bar", x: "region", y: "channel", agg: "max" }],
    ["an agg without y", { type: "bar", x: "region", agg: "sum" }],
  ])("refuses %s", (_name, spec) => {
    expect(failure(() => compile(spec)).error.code).toBe("spec_invalid");
  });

  it("allows min/max of a date and types y as temporal", () => {
    const { sql, vegaLite } = compile({ type: "bar", x: "region", y: "ts", agg: "max" });
    expect(sql).toContain('max("ts") AS y');
    expect(enc(vegaLite).y).toMatchObject({ type: "temporal", title: "max(ts)" });
  });
});
