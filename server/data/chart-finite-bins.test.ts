import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { compileChart } from "./chart-compiler.ts";
import { createDataEngine } from "./engine.ts";
import { chartRenderer } from "./render.ts";
import { dataRpc, type DataRpcDeps } from "./rpc.ts";
import { DataSheetStore } from "./sheet.ts";
import { type DataToolResult, renderCard } from "./tools.ts";
import type { OmbChartSpec } from "./types.ts";
import { validateVegaLite } from "./vega-lite-validator.ts";

const root = mkdtempSync(join(tmpdir(), "omb-chart-finite-"));
const engine = createDataEngine({ botFolder: (id) => join(root, id), dataDir: join(root, "data") });
const connection = "bot" as const;
afterAll(async () => {
  await engine.closeAll();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function chart(sql: string, spec: OmbChartSpec) {
  const database = await engine.forBot("bins");
  const columns = (await database.run(`SELECT * FROM (${sql}) LIMIT 0`, { connection })).columns;
  const compiled = compileChart(spec, columns, `(${sql})`);
  const result = await database.run(compiled.sql, { connection });
  return { compiled, ...result };
}

describe("numeric chart bins with nonfinite query results", () => {
  it.each(["bar", "histogram", "line", "area"] as const)("keeps finite %s bins when ratios include division by zero", async (type) => {
    const result = await chart("SELECT * FROM (VALUES (1.0::DOUBLE), (2.0), (1.0/0.0), (-1.0/0.0), (0.0/0.0), (NULL)) t(value)", { type, x: "value", bins: 2 });
    const visible = result.rows.filter(([x]) => x !== null);
    expect(visible.map((row) => Number(row.at(-1)))).toEqual([1, 1]);
    expect(visible.map(([x]) => x)).toEqual(type === "bar" || type === "histogram" ? [1, 1.5] : [1.25, 1.75]);
    expect(result.rows.filter(([x]) => x === null).map((row) => Number(row.at(-1)))).toEqual([4]);
    expect(result.rows.flat()).not.toEqual(expect.arrayContaining(["NaN", "Infinity", "-Infinity"]));
  });

  it("does not add a nonfinite coordinate's measure to a finite bar", async () => {
    const result = await chart("SELECT * FROM (VALUES (1.0::DOUBLE, 3), (2.0, 5), (1.0/0.0, 100)) t(value, amount)", {
      type: "bar", x: "value", y: "amount", bins: 2,
    });
    expect(result.rows).toEqual([[1, 1.5, "3"], [1.5, 2, "5"], [null, null, "100"]]);
  });

  it("handles both numeric heatmap axes without losing finite cells", async () => {
    const result = await chart("SELECT * FROM (VALUES (1.0::DOUBLE, 10.0::DOUBLE), (2.0, 20.0), (1.0/0.0, 20.0), (2.0, 0.0/0.0), (-1.0/0.0, 1.0/0.0)) t(horizontal, vertical)", {
      type: "heatmap", x: "horizontal", color: "vertical", bins: 2,
    });
    expect(result.rows.filter(([x, , y]) => x !== null && y !== null)).toEqual([[1, 1.5, 10, 15, "1"], [1.5, 2, 15, 20, "1"]]);
    expect(result.rows.filter(([x, , y]) => x === null || y === null)).toHaveLength(3);
    expect(result.rows.flat()).not.toEqual(expect.arrayContaining(["NaN", "Infinity", "-Infinity"]));
  });

  it("preserves a constant finite distribution beside NaN", async () => {
    const result = await chart("SELECT * FROM (VALUES (7.0::DOUBLE), (7.0), (0.0/0.0)) t(value)", { type: "histogram", x: "value" });
    expect(result.rows).toEqual([[7, 8, "2"], [null, null, "1"]]);
  });

  it("keeps all-invalid coordinates missing and empty input empty", async () => {
    const missing = await chart("SELECT * FROM (VALUES (1.0/0.0), (-1.0/0.0), (0.0/0.0), (NULL)) t(value)", { type: "histogram", x: "value" });
    expect(missing.rows).toEqual([[null, null, "4"]]);
    expect((await chart("SELECT 1.0::DOUBLE AS value WHERE false", { type: "histogram", x: "value" })).rows).toEqual([]);
  });

  it("keeps ordinary whole-number bins and nonfinite-looking text categories", async () => {
    expect((await chart("SELECT * FROM (VALUES (1), (2)) t(value)", { type: "histogram", x: "value", bins: 2 })).rows).toEqual([[1, 2, "1"], [2, 3, "1"]]);
    expect((await chart("SELECT * FROM (VALUES ('NaN'), ('Infinity'), ('Infinity')) t(value)", { type: "bar", x: "value", sort: "x" })).rows).toEqual([["Infinity", "2"], ["NaN", "1"]]);
  });

  it("saves, reloads and exports the finite bars from a real Data MCP chart", async () => {
    const botId = "rpc";
    const dir = join(root, botId);
    const database = await engine.forBot(botId);
    const published: string[] = [];
    const deps: DataRpcDeps = {
      database, sheet: new DataSheetStore({ botId, dir }), compileChart, validateVegaLite, renderer: chartRenderer,
      exportRoots: () => [root], signal: new AbortController().signal,
      assertActive() {}, onShow: (card) => published.push(card.id),
    };
    const call = (name: string, args: Record<string, unknown>) => dataRpc({ method: "tools/call", params: { name, arguments: args } }, deps) as Promise<DataToolResult>;
    const shown = await call("data_show", {
      kind: "chart", title: "Ratios", chart: { type: "histogram", x: "ratio", bins: 2 },
      sql: "SELECT numerator / denominator AS ratio FROM (VALUES (1.0, 1.0), (2.0, 1.0), (1.0, 0.0), (0.0, 0.0)) t(numerator, denominator)",
    });
    expect(shown.isError).not.toBe(true);
    const id = String(shown.structuredContent?.id);
    expect(published).toEqual([id]);
    deps.sheet = new DataSheetStore({ botId, dir });
    const card = deps.sheet.card(id)!;
    expect(card).toMatchObject({ status: "ready", reduction: { inputRows: 4 }, chart: { type: "histogram" } });
    const saved = await database.page(`omb_results."${card.result}"`, { offset: 0, limit: 10 });
    expect(saved.rows).toEqual([[1, 1.5, "1"], [1.5, 2, "1"], [null, null, "2"]]);
    const svg = String(await renderCard({ ...deps, by: "bot", connection }, card, "svg"));
    expect(svg.match(/aria-roledescription="bar"/g)).toHaveLength(2);
    const exported = await call("data_export", { id, format: "svg", path: join(root, "ratios.svg") });
    expect(exported.isError).not.toBe(true);
    expect(readFileSync(String(exported.structuredContent?.path), "utf8")).toBe(svg);
  });
});
