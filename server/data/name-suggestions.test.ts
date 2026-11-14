import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { closeNames, createDataEngine } from "./engine.ts";

describe("data name suggestions", () => {
  it("ranks long prefix and substring matches without an edit-distance matrix", () => {
    const wanted = "revenue_for_current_reporting_month";
    const names = Array.from({ length: 100 }, (_, i) => `${wanted}_${String(i).padStart(3, "0")}`);
    names.push(`previous_${wanted}`);
    const minimum = vi.spyOn(Math, "min");
    try {
      expect(closeNames(wanted, names)).toEqual(names.slice(0, 5));
      expect(minimum.mock.calls.length).toBeLessThan(1_000);
    } finally {
      minimum.mockRestore();
    }
  });

  it("rejects impossible length differences without an edit-distance matrix", () => {
    const names = Array.from({ length: 100 }, (_, i) => `unrelated_${i}_${"monthly_summary_".repeat(4)}`);
    const minimum = vi.spyOn(Math, "min");
    try {
      expect(closeNames("revenue", names)).toEqual([]);
      expect(minimum.mock.calls.length).toBeLessThan(1_000);
    } finally {
      minimum.mockRestore();
    }
  });

  it("keeps prefix priority ahead of nearer fuzzy and substring matches", () => {
    expect(closeNames("sale", ["xsale", "pale", "sales_summary", "sa", "salo", "sale"])).toEqual([
      "sale", "sa", "sales_summary", "pale", "salo",
    ]);
  });

  it("still measures candidates at the length budget and rejects those beyond it", () => {
    expect(closeNames("abcdef", ["acdf", "abxyef", "abxyzf", "acf", "abxycdef", "zabcdez"])).toEqual([
      "abxycdef", "abxyef", "acdf", "zabcdez",
    ]);
  });

  it("preserves case folding, Unicode code units, and original names", () => {
    expect(closeNames("İd", ["İd_number", "id", "i\u0307d", "İD", "before_İd", "😀😀😀😀"])).toEqual([
      "i\u0307d", "İD", "İd_number", "id", "before_İd",
    ]);
    expect(closeNames("😀", ["😀_long", "x😀", "😃", "😀"])).toEqual(["😀", "😀_long", "😃", "x😀"]);
  });

  it("keeps duplicates and the requested result limit without changing the input", () => {
    const names = Object.freeze(["sales", "sale", "sales", "orders"]);
    expect(closeNames("sale", names, 10)).toEqual(["sale", "sales", "sales"]);
    expect(closeNames("sale", names, 1)).toEqual(["sale"]);
    expect(closeNames("sale", names, 0)).toEqual([]);
    expect(names).toEqual(["sales", "sale", "sales", "orders"]);
  });

  it("retains empty targets and candidates", () => {
    expect(closeNames("", ["bbb", "aa", "c", ""])).toEqual(["", "c", "aa", "bbb"]);
    expect(closeNames("abcdef", ["", "abc"])).toEqual(["abc", ""]);
    expect(closeNames("sale", [])).toEqual([]);
  });

  it("returns the same suggestions through real DuckDB table and column failures", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omb-name-suggestions-"));
    const engine = createDataEngine({ botFolder: (id) => join(directory, id), dataDir: directory, env: {} });
    try {
      const db = await engine.forBot("fixture");
      await db.run("CREATE TABLE sales (revenue INTEGER, revenue_total INTEGER, cost INTEGER)", { connection: "bot" });
      await expect(db.page("sal", { offset: 0, limit: 10 })).rejects.toMatchObject({
        error: { code: "table_not_found", candidates: ["sales"] },
      });
      for (const option of [{ sort: { column: "revenu", direction: "asc" as const } }, { filterColumn: "revenu" }]) {
        await expect(db.page("sales", { offset: 0, limit: 10, ...option })).rejects.toMatchObject({
          error: { code: "invalid_input", candidates: ["revenue", "revenue_total"] },
        });
      }
      expect((await db.page("sales", { offset: 0, limit: 10 })).columns.map((column) => column.name)).toEqual([
        "revenue", "revenue_total", "cost",
      ]);
    } finally {
      await engine.closeAll();
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
