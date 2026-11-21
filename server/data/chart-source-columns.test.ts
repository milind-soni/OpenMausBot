import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { OmbChartSpec } from "./types.ts";
import { compileChart } from "./chart-compiler.ts";

let instance: DuckDBInstance;
let connection: DuckDBConnection;

beforeAll(async () => {
  instance = await DuckDBInstance.create(":memory:");
  connection = await instance.connect();
});
afterAll(() => {
  connection?.closeSync();
  instance?.closeSync();
});

async function chartRows(sql: string, spec: OmbChartSpec) {
  const source = `(${sql})`;
  const described = await connection.run(`SELECT * FROM ${source} LIMIT 0`);
  const columns = Array.from({ length: described.columnCount }, (_, i) => ({
    name: described.columnName(i), type: described.columnType(i).toString(),
  }));
  const compiled = compileChart(spec, columns, source);
  const result = await connection.runAndReadAll(compiled.sql);
  return result.getRowsJson();
}

describe("chart source columns alongside reduction columns", () => {
  it.each(["lo", "width", "LO", "Width"])("bins a source axis named %s", async (name) => {
    const rows = await chartRows(`SELECT * FROM (VALUES (1, 3), (2, 5)) t("${name}", amount)`, {
      type: "bar", x: name, y: "amount", bins: 2,
    });
    expect(rows.map(([x, x2, y]) => [x, x2, Number(y)])).toEqual([[1, 2, 3], [2, 3, 5]]);
  });

  it.each(["lo", "width"])("aggregates a source measure named %s", async (name) => {
    const rows = await chartRows(`SELECT * FROM (VALUES (1, 3), (2, 5)) t(position, "${name}")`, {
      type: "bar", x: "position", y: name, bins: 2,
    });
    expect(rows.map(([x, x2, y]) => [x, x2, Number(y)])).toEqual([[1, 2, 3], [2, 3, 5]]);
  });

  it("keeps a source color named width separate from the bin width", async () => {
    const rows = await chartRows("SELECT * FROM (VALUES (1, 'small', 3), (2, 'large', 5)) t(position, width, amount)", {
      type: "bar", x: "position", color: "width", y: "amount", bins: 2,
    });
    expect(rows.map(([x, x2, color, y]) => [x, x2, color, Number(y)])).toEqual([[1, 2, "small", 3], [2, 3, "large", 5]]);
  });

  it("buckets source dates named unit", async () => {
    const rows = await chartRows("SELECT * FROM (VALUES (DATE '2026-01-01', 3), (DATE '2026-01-02', 5)) t(unit, amount)", {
      type: "bar", x: "unit", y: "amount",
    });
    expect(rows.map(([x, , y]) => [String(x).slice(0, 10), Number(y)])).toEqual([["2026-01-01", 3], ["2026-01-02", 5]]);
  });

  it("reduces source timestamps named t0 without confusing them with the range", async () => {
    const rows = await chartRows("SELECT * FROM (VALUES (TIMESTAMP '2026-01-01', 3), (TIMESTAMP '2026-01-02', 5)) t(t0, amount)", {
      type: "line", x: "t0", y: "amount",
    });
    expect(rows.map(([x, y]) => [String(x).slice(0, 10), Number(y)])).toEqual([["2026-01-01", 3], ["2026-01-02", 5]]);
  });

  it("reduces a source measure named t1 without confusing it with the range", async () => {
    const rows = await chartRows("SELECT * FROM (VALUES (TIMESTAMP '2026-01-01', 3), (TIMESTAMP '2026-01-02', 5)) t(moment, t1)", {
      type: "line", x: "moment", y: "t1",
    });
    expect(rows.map(([x, y]) => [String(x).slice(0, 10), Number(y)])).toEqual([["2026-01-01", 3], ["2026-01-02", 5]]);
  });

  it("bins both heatmap axes when each shares a reduction column name", async () => {
    const rows = await chartRows("SELECT * FROM (VALUES (1, 3, 7), (2, 4, 11)) t(lo, width, amount)", {
      type: "heatmap", x: "lo", color: "width", y: "amount", bins: 2,
    });
    expect(rows.map(([x, x2, y, y2, color]) => [x, x2, y, y2, Number(color)])).toEqual([[1, 2, 3, 4, 7], [2, 3, 4, 5, 11]]);
  });

  it("preserves ordinary axis and measure columns", async () => {
    const rows = await chartRows("SELECT * FROM (VALUES (1, 3), (2, 5)) t(position, amount)", {
      type: "bar", x: "position", y: "amount", bins: 2,
    });
    expect(rows.map(([x, x2, y]) => [x, x2, Number(y)])).toEqual([[1, 2, 3], [2, 3, 5]]);
  });
});
