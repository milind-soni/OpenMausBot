import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileChart } from "./chart-compiler.ts";

let instance: DuckDBInstance;
let connection: DuckDBConnection;
beforeAll(async () => { instance = await DuckDBInstance.create(":memory:"); connection = await instance.connect(); });
afterAll(() => { connection?.closeSync(); instance?.closeSync(); });

async function scatter(sql: string) {
  const source = `(${sql})`;
  const described = await connection.run(`SELECT * FROM ${source} LIMIT 0`);
  const columns = Array.from({ length: described.columnCount }, (_, i) => ({ name: described.columnName(i), type: described.columnType(i).toString() }));
  const compiled = compileChart({ type: "scatter", x: "horizontal", y: "vertical" }, columns, source);
  return (await connection.runAndReadAll(compiled.sql)).getRowsJson();
}

describe("scatter sampling with missing coordinates", () => {
  it("retains every drawable numeric point when missing rows exceed the sample budget", async () => {
    const rows = await scatter("SELECT NULL::INTEGER AS horizontal, i AS vertical FROM range(100000) t(i) UNION ALL SELECT i, i FROM range(40) t(i)");
    expect(rows).toHaveLength(40);
    expect(rows.map(([x]) => Number(x)).sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, i) => i));
  });

  it("filters missing temporal coordinates before sampling", async () => {
    const rows = await scatter("SELECT NULL::DATE AS horizontal, i AS vertical FROM range(100000) t(i) UNION ALL SELECT DATE '2024-01-01' + INTERVAL (i) DAY, i FROM range(40) t(i)");
    expect(rows).toHaveLength(40);
    expect(rows.every(([x]) => x !== null)).toBe(true);
  });

  it("does not discard a missing nominal category", async () => {
    const rows = await scatter("SELECT * FROM (VALUES (NULL::VARCHAR, 1), ('named', 2)) t(horizontal, vertical)");
    expect(rows).toHaveLength(2);
    expect(rows.some(([x]) => x === null)).toBe(true);
  });

  it("excludes missing y coordinates, including an entirely empty drawable set", async () => {
    expect(await scatter("SELECT * FROM (VALUES (1, NULL::INTEGER), (2, 2)) t(horizontal, vertical)")).toEqual([[2, 2]]);
    expect(await scatter("SELECT 1 AS horizontal, NULL::INTEGER AS vertical FROM range(100)")).toEqual([]);
  });

  it("keeps the sample bounded after filtering", async () => {
    const rows = await scatter("SELECT i AS horizontal, i AS vertical FROM range(20000) t(i)");
    expect(rows).toHaveLength(10000);
  });
});
