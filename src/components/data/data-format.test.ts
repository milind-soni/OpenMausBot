import { describe, expect, it } from "vitest";
import { DATA_LIMITS, type DataCard, type DataSheet } from "../../../shared/data-surface";
import {
  cardResultTable, cardsOldestFirst, cellNumber, cellText, defaultColumnWidth, isNumericType, isTemporalType,
  markdownTable, pagesCovering, pageWindow, rowObjects, sqlNamespace, tsv,
} from "./data-format";

const card = (id: string, createdAt: string, extra: Partial<DataCard> = {}): DataCard => ({
  id, kind: "table", title: id, status: "ready", by: "bot", createdAt, updatedAt: createdAt, ...extra,
});

describe("data helpers", () => {
  it("knows DuckDB's number and time types", () => {
    for (const type of ["BIGINT", "INTEGER", "UBIGINT", "HUGEINT", "DECIMAL(18,3)", "DOUBLE", "FLOAT", "REAL", "SMALLINT", "TINYINT"]) expect(isNumericType(type), type).toBe(true);
    for (const type of ["VARCHAR", "BOOLEAN", "DATE", "TIMESTAMP", "INTERVAL", "BLOB", "INTEGER[]"]) expect(isNumericType(type), type).toBe(type === "INTEGER[]");
    expect(isTemporalType("TIMESTAMP WITH TIME ZONE")).toBe(true);
    expect(isTemporalType("VARCHAR")).toBe(false);
  });

  it("turns cells into text and numbers", () => {
    expect(cellText(null)).toBe("");
    expect(cellText(true)).toBe("true");
    expect(cellText(12)).toBe("12");
    expect(cellNumber("12345678901234567890")).toBe(12345678901234567000);
    expect(cellNumber("1.50")).toBe(1.5);
    expect(cellNumber("")).toBeNull();
    expect(cellNumber("abc")).toBeNull();
  });

  it("binds rows as objects, with numeric columns as numbers", () => {
    const rows = rowObjects([{ name: "n", type: "BIGINT" }, { name: "s", type: "VARCHAR" }], [["42", "a"], [null, null]]);
    expect(rows).toEqual([{ n: 42, s: "a" }, { n: null, s: null }]);
  });

  it("copies as TSV and Markdown without breaking the shape", () => {
    expect(tsv(["a", "b"], [["x\ty", null], [1, true]])).toBe("a\tb\nx y\t\n1\ttrue");
    expect(markdownTable(["a|b", "c"], [["x|y", "z\nw"]])).toBe("| a\\|b | c |\n| --- | --- |\n| x\\|y | z w |");
  });

  it("asks for the pages that cover a row range, never more than pageSize rows each", () => {
    const size = DATA_LIMITS.pageSize;
    expect(pagesCovering(0, 10)).toEqual([0]);
    expect(pagesCovering(size - 1, size)).toEqual([0, 1]);
    expect(pagesCovering(3 * size + 5, 3 * size + 40)).toEqual([3]);
    expect(pagesCovering(5, 2)).toEqual([]);
    expect(pageWindow(0, 5000)).toEqual({ offset: 0, limit: size });
    expect(pageWindow(4, 5000)).toEqual({ offset: 4 * size, limit: 5000 - 4 * size });
    expect(pageWindow(0, 0).limit).toBe(1);
    for (let page = 0; page < 6; page++) expect(pageWindow(page, 5000).limit).toBeLessThanOrEqual(size);
  });

  it("gives numbers narrow columns and text wide ones", () => {
    expect(defaultColumnWidth({ name: "n", type: "BIGINT" })).toBe(110);
    expect(defaultColumnWidth({ name: "description", type: "VARCHAR" })).toBe(180);
    expect(defaultColumnWidth({ name: "a_very_long_column_name_that_goes_on_and_on_forever", type: "VARCHAR" })).toBe(320);
  });

  it("names a card's result table and builds the editor's namespace", () => {
    expect(cardResultTable({ result: "q_3" })).toBe("omb_results.q_3");
    expect(cardResultTable({ result: null })).toBeNull();
    const sheet: DataSheet = {
      version: 1, botId: "b", updatedAt: "", sources: [{ name: "sales", kind: "csv", source: "/s.csv", rowCount: 2, loadedAt: "", columns: [{ name: "amount", type: "DOUBLE" }, { name: "day", type: "DATE" }] }],
      cards: [card("c1", "2026-10-09T10:00:00Z", { result: "q_1", columns: [{ name: "total", type: "DOUBLE" }] }), card("c2", "2026-10-09T10:01:00Z", { status: "failed", result: null })],
    };
    expect(sqlNamespace(sheet)).toEqual({ sales: ["amount", "day"], omb_results: { q_1: ["total"] } });
    expect(sqlNamespace(undefined)).toEqual({});
  });

  it("orders cards oldest first whatever the server stored", () => {
    const ordered = cardsOldestFirst([card("new", "2026-10-09T12:00:00Z"), card("old", "2026-10-09T09:00:00Z"), card("mid", "2026-10-09T10:00:00Z")]);
    expect(ordered.map((entry) => entry.id)).toEqual(["old", "mid", "new"]);
  });
});
