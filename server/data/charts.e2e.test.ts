// The whole chart path on a real DuckDB: compile the bot's spec → run the
// reducing SQL in-memory → bind the JSON rows → SVG. No engine module yet;
// this talks to @duckdb/node-api directly, the way engine.ts will.
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DATA_LIMITS, type DataColumn, type OmbChartSpec } from "../../shared/data-surface.ts";
import { CHART_SQL_LIMIT, compileChart } from "./chart-compiler.ts";
import { chartRenderer } from "./render.ts";

type Cell = string | number | boolean | null;

let connection: DuckDBConnection;

async function describeTable(table: string): Promise<DataColumn[]> {
  const result = await connection.runAndReadAll(`DESCRIBE ${table}`);
  return result.getRowObjectsJson().map((row) => ({ name: String(row.column_name), type: String(row.column_type) }));
}

/** Runs a compiled statement and shapes it as the engine's RunResult will:
 * columns with DuckDB's type names, rows as JSON cells. */
async function run(sql: string): Promise<{ columns: DataColumn[]; rows: Cell[][] }> {
  const result = await connection.runAndReadAll(sql);
  const names = result.columnNames();
  const types = result.columnTypes().map((t) => t.toString());
  return {
    columns: names.map((name, i) => ({ name, type: types[i]! })),
    rows: result.getRowsJson() as Cell[][],
  };
}

async function chart(spec: OmbChartSpec, table: string) {
  const columns = await describeTable(table);
  const compiled = compileChart(spec, columns, table);
  const reduced = await run(compiled.sql);
  return { compiled, reduced };
}

beforeAll(async () => {
  const instance = await DuckDBInstance.create(":memory:");
  connection = await instance.connect();
  await connection.run(`CREATE TABLE sales AS
    SELECT i AS id,
           'region ' || (i % 37) AS region,
           CASE WHEN i % 3 = 0 THEN 'web' ELSE 'shop' END AS channel,
           CAST(((i * 7919) % 100000) / 100.0 AS DECIMAL(10,2)) AS amount,
           DATE '2024-01-01' + INTERVAL (i % 400) DAY AS d,
           TIMESTAMP '2024-01-01' + INTERVAL (i) MINUTE AS ts
    FROM range(5000) r(i)`);
  await connection.run(`CREATE TABLE big AS
    SELECT i AS id,
           'cat ' || (i % 1000) AS cat,
           'row ' || (i % 400) AS a,
           'col ' || (CAST(floor(i / 400) AS INTEGER) % 400) AS b,
           ((i * 7919) % 100000) / 100.0 AS amount,
           random() * 100 AS noise,
           TIMESTAMP '2024-01-01' + INTERVAL (i) SECOND AS ts
    FROM range(100000) r(i)`);
});

afterAll(() => {
  connection?.closeSync();
});

describe("charts end to end on DuckDB", () => {
  it("bar: folds 37 regions to the top 20 and other, and renders", async () => {
    const { compiled, reduced } = await chart({ type: "bar", x: "region", y: "amount", sort: "-y" }, "sales");
    expect(compiled.reduction.method).toBe("topN");
    expect(reduced.columns.map((c) => c.name)).toEqual(["x", "y"]);
    expect(reduced.rows).toHaveLength(21);
    const labels = reduced.rows.map((r) => r[0]);
    expect(labels).toContain("other");
    // The sum of a DECIMAL comes back as a string; the renderer makes it a number.
    expect(typeof reduced.rows[0]![1]).toBe("string");
    const svg = await chartRenderer.svg(compiled.vegaLite, reduced.rows, reduced.columns, { theme: "light" });
    expect(svg).toContain("<svg");
    expect(svg).toContain(">other</text>");
    expect(svg).toContain(">region</text>");
  });

  it("bar with a series stacks web and shop per region", async () => {
    const { reduced } = await chart({ type: "bar", x: "region", y: "amount", color: "channel" }, "sales");
    expect(reduced.columns.map((c) => c.name)).toEqual(["x", "color", "y"]);
    expect(reduced.rows).toHaveLength(42);
    expect(new Set(reduced.rows.map((r) => r[1]))).toEqual(new Set(["web", "shop"]));
  });

  it("line: picks hour buckets for a 3.5-day range, day buckets for a 400-day one", async () => {
    const hours = await chart({ type: "line", x: "ts", y: "amount", agg: "avg" }, "sales");
    expect(hours.compiled.reduction.method).toBe("timeBucket");
    expect(hours.reduced.rows).toHaveLength(84);
    expect(hours.reduced.rows[1]![0]).toBe("2024-01-01 01:00:00");
    const days = await chart({ type: "bar", x: "d" }, "sales");
    expect(days.reduced.columns.map((c) => c.name)).toEqual(["x", "x2", "y"]);
    expect(days.reduced.rows).toHaveLength(400);
    // A unit chosen in SQL widens the DATE to a TIMESTAMP; the day is the same.
    expect(String(days.reduced.rows[0]![0]).startsWith("2024-01-01")).toBe(true);
    expect(String(days.reduced.rows[0]![1]).startsWith("2024-01-02")).toBe(true);
    const months = await chart({ type: "line", x: "d", timeUnit: "month" }, "sales");
    expect(months.reduced.rows).toHaveLength(14);
    const svg = await chartRenderer.svg(hours.compiled.vegaLite, hours.reduced.rows, hours.reduced.columns, { theme: "dark" });
    expect(svg).toContain("<svg");
    expect(svg).toContain(">avg(amount)</text>");
  });

  it("line of a raw series: M4 keeps at most four points per pixel column and every extreme", async () => {
    const { compiled, reduced } = await chart({ type: "line", x: "ts", y: "amount" }, "big");
    expect(compiled.reduction.method).toBe("m4");
    expect(reduced.rows.length).toBeLessThanOrEqual(4 * 800);
    expect(reduced.rows.length).toBeGreaterThan(800);
    const ys = reduced.rows.map((r) => Number(r[1]));
    const [{ lo, hi }] = (await connection.runAndReadAll("SELECT min(amount) AS lo, max(amount) AS hi FROM big")).getRowObjectsJson() as Array<{ lo: number; hi: number }>;
    expect(Math.min(...ys)).toBe(Number(lo));
    expect(Math.max(...ys)).toBe(Number(hi));
    const svg = await chartRenderer.svg(compiled.vegaLite, reduced.rows, reduced.columns, { theme: "light" });
    expect(svg).toContain("<svg");
  });

  it("histogram: 30 bins that cover the range, counts as strings, and renders", async () => {
    const { compiled, reduced } = await chart({ type: "histogram", x: "amount" }, "sales");
    expect(compiled.reduction.method).toBe("bins");
    expect(reduced.columns.map((c) => c.name)).toEqual(["x", "x2", "y"]);
    expect(reduced.rows).toHaveLength(30);
    const total = reduced.rows.reduce((n, r) => n + Number(r[2]), 0);
    expect(total).toBe(5000);
    // Counts are BIGINT: strings in JSON until the renderer coerces them.
    expect(typeof reduced.rows[0]![2]).toBe("string");
    const [{ lo, hi }] = (await connection.runAndReadAll("SELECT min(amount) AS lo, max(amount) AS hi FROM sales")).getRowObjectsJson() as Array<{ lo: string; hi: string }>;
    expect(Number(reduced.rows[0]![0])).toBeCloseTo(Number(lo), 6);
    expect(Number(reduced.rows[29]![1])).toBeCloseTo(Number(hi), 6);
    const svg = await chartRenderer.svg(compiled.vegaLite, reduced.rows, reduced.columns, { theme: "light" });
    expect(svg).toContain(">amount</text>");
    expect(svg).toContain(">count</text>");
  });

  it("scatter: a small table comes back whole; 100k rows come back as a 10,000-row sample", async () => {
    const small = await chart({ type: "scatter", x: "id", y: "amount", color: "channel" }, "sales");
    expect(small.compiled.reduction.method).toBe("sample");
    expect(small.reduced.rows).toHaveLength(5000);
    const sampled = await chart({ type: "scatter", x: "amount", y: "noise", size: "id" }, "big");
    expect(sampled.reduced.rows).toHaveLength(DATA_LIMITS.chartMaxMarks);
    expect(sampled.reduced.rows.length).toBeLessThan(CHART_SQL_LIMIT);
    // Repeatable: the same seed draws the same rows.
    const again = await run(sampled.compiled.sql);
    expect(again.rows.map((r) => r[0])).toEqual(sampled.reduced.rows.map((r) => r[0]));
    const svg = await chartRenderer.svg(sampled.compiled.vegaLite, sampled.reduced.rows, sampled.reduced.columns, { theme: "dark" });
    expect(svg).toContain("<svg");
  });

  it("pie and heatmap render", async () => {
    const pie = await chart({ type: "pie", x: "channel", y: "amount" }, "sales");
    expect(pie.reduced.rows).toHaveLength(2);
    expect((await chartRenderer.svg(pie.compiled.vegaLite, pie.reduced.rows, pie.reduced.columns, { theme: "light" })).match(/aria-roledescription="arc mark"/g)).toHaveLength(2);
    const heat = await chart({ type: "heatmap", x: "channel", color: "d", y: "amount", agg: "avg" }, "sales");
    expect(heat.compiled.reduction.method).toBe("group");
    expect(heat.reduced.columns.map((c) => c.name)).toEqual(["x", "y", "y2", "color"]);
    expect(heat.reduced.rows).toHaveLength(2 * 400);
    expect(await chartRenderer.svg(heat.compiled.vegaLite, heat.reduced.rows, heat.reduced.columns, { theme: "dark" })).toContain("<svg");
  });

  it("the LIMIT contract: a reduction that overflows returns exactly chartMaxMarks + 1 rows", async () => {
    // 400 × 250 cells = 100,000 groups: more than any chart may draw.
    const { compiled, reduced } = await chart({ type: "heatmap", x: "a", color: "b" }, "big");
    expect(compiled.sql.trimEnd().endsWith(`LIMIT ${CHART_SQL_LIMIT}`)).toBe(true);
    expect(reduced.rows).toHaveLength(CHART_SQL_LIMIT);
    // While a fold stays under it, exactly: 1,000 categories → 20 + other.
    const folded = await chart({ type: "bar", x: "cat", y: "amount" }, "big");
    expect(folded.reduced.rows).toHaveLength(21);
    expect(folded.reduced.rows.length).toBeLessThan(CHART_SQL_LIMIT);
  });

  it("reads from a subquery and quotes awkward column names", async () => {
    await connection.run(`CREATE TABLE awkward AS SELECT 'a' || (i % 3) AS "order", i AS "we""ird" FROM range(30) r(i)`);
    const columns = await describeTable("awkward");
    expect(columns.map((c) => c.name)).toEqual(["order", 'we"ird']);
    const compiled = compileChart({ type: "bar", x: "order", y: 'we"ird' }, columns, '(SELECT * FROM awkward WHERE "we""ird" < 20)');
    const reduced = await run(compiled.sql);
    expect(reduced.rows).toHaveLength(3);
    expect(reduced.rows.reduce((n, r) => n + Number(r[1]), 0)).toBe(190);
  });
});
