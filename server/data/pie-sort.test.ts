import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { parse, View } from "vega";
import { compile, type TopLevelSpec } from "vega-lite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { OmbChartSpec } from "../../shared/data-surface.ts";
import { compileChart } from "./chart-compiler.ts";
import { coerceRows } from "./render.ts";
import type { RunResult } from "./types.ts";

let instance: DuckDBInstance;
let connection: DuckDBConnection;
beforeAll(async () => { instance = await DuckDBInstance.create(":memory:"); connection = await instance.connect(); });
afterAll(() => { connection?.closeSync(); instance?.closeSync(); });

describe("pie slice ordering", () => {
  it.each([
    ["x", ["Alpha", "Beta", "Gamma"]],
    ["-x", ["Gamma", "Beta", "Alpha"]],
    ["y", ["Gamma", "Alpha", "Beta"]],
    ["-y", ["Beta", "Alpha", "Gamma"]],
    [undefined, ["Beta", "Alpha", "Gamma"]],
  ] as Array<[OmbChartSpec["sort"], string[]]>)("draws slices in %s order", async (sort, expected) => {
    const source = "(SELECT * FROM (VALUES ('Gamma', 10), ('Alpha', 20), ('Beta', 30)) sales(region, amount))";
    const plan = compileChart({ type: "pie", x: "region", y: "amount", sort }, [
      { name: "region", type: "VARCHAR" }, { name: "amount", type: "INTEGER" },
    ], source);
    const result = await connection.runAndReadAll(plan.sql);
    const rows = result.getRowsJson() as RunResult["rows"];
    const runtime = compile({ ...plan.vegaLite, width: 400 } as unknown as TopLevelSpec).spec;
    const view = new View(parse(runtime), { renderer: "none" });
    try {
      view.data("table", coerceRows(rows, [
        { name: "x", type: "VARCHAR" }, { name: "y", type: "HUGEINT" },
      ]));
      await view.runAsync();
      const segments: Array<{ label: string; start: number }> = [];
      const visit = (item: { mark?: { marktype?: string }; datum?: { x?: string }; startAngle?: number; items?: unknown[] }) => {
        if (item.mark?.marktype === "arc") segments.push({ label: item.datum!.x!, start: item.startAngle! });
        for (const child of item.items ?? []) visit(child as typeof item);
      };
      visit((view.scenegraph() as unknown as { root: Parameters<typeof visit>[0] }).root);
      expect(segments.sort((a, b) => a.start - b.start).map(({ label }) => label)).toEqual(expected);
    } finally {
      view.finalize();
    }
  });
});
