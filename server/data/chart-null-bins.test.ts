import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compileChart } from "./chart-compiler.ts";
import type { OmbChartSpec } from "./types.ts";

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

async function rows(sql: string, spec: OmbChartSpec) {
  const source = `(${sql})`;
  const described = await connection.run(`SELECT * FROM ${source} LIMIT 0`);
  const columns = Array.from({ length: described.columnCount }, (_, i) => ({
    name: described.columnName(i), type: described.columnType(i).toString(),
  }));
  const result = await connection.runAndReadAll(compileChart(spec, columns, source).sql);
  return result.getRowsJson();
}

describe("missing numeric chart coordinates", () => {
  it.each(["bar", "histogram", "line", "area"] as const)("keeps null values separate from the final %s bin", async (type) => {
    const result = await rows("SELECT * FROM (VALUES (1), (2), (NULL)) t(value)", { type, x: "value", bins: 2 });
    const visible = result.filter(([x]) => x !== null);
    expect(visible.map((row) => Number(row.at(-1)))).toEqual([1, 1]);
    const missing = result.filter(([x]) => x === null);
    expect(missing).toHaveLength(1);
    expect(Number(missing[0]!.at(-1))).toBe(1);
    if (type === "bar" || type === "histogram") expect(missing[0]![1]).toBeNull();
  });

  it("does not add a missing coordinate's measure to a real numeric bin", async () => {
    const result = await rows("SELECT * FROM (VALUES (1.0, 3), (2.0, 5), (NULL, 100)) t(value, amount)", {
      type: "bar", x: "value", y: "amount", bins: 2,
    });
    expect(result.filter(([x]) => x !== null).map((row) => Number(row.at(-1)))).toEqual([3, 5]);
    expect(Number(result.find(([x]) => x === null)?.at(-1))).toBe(100);
  });

  it("keeps missing coordinates out of both numeric heatmap axes", async () => {
    const result = await rows("SELECT * FROM (VALUES (1, 10), (2, 20), (NULL, 20), (2, NULL), (NULL, NULL)) t(horizontal, vertical)", {
      type: "heatmap", x: "horizontal", color: "vertical", bins: 2,
    });
    expect(result.filter(([x, , y]) => x !== null && y !== null).map((row) => Number(row.at(-1)))).toEqual([1, 1]);
    expect(result.filter(([x, , y]) => x === null || y === null)).toHaveLength(3);
  });

  it("preserves all-null and empty numeric input", async () => {
    const missing = await rows("SELECT NULL::INTEGER AS value FROM range(3)", { type: "histogram", x: "value" });
    expect(missing).toEqual([[null, null, "3"]]);
    expect(await rows("SELECT 1 AS value WHERE false", { type: "histogram", x: "value" })).toEqual([]);
  });
});
