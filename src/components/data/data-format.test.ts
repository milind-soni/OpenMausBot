import { describe, expect, it } from "vitest";
import type { DataCard } from "../../../shared/data-surface";
import {
  cardsLatestFirst, cellNumber, cellText, defaultColumnWidth, isNumericType, isTemporalType,
  markdownTable, rowObjects, tsv,
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

  it("gives numbers narrow columns and text wide ones", () => {
    expect(defaultColumnWidth({ name: "n", type: "BIGINT" })).toBe(110);
    expect(defaultColumnWidth({ name: "description", type: "VARCHAR" })).toBe(180);
    expect(defaultColumnWidth({ name: "a_very_long_column_name_that_goes_on_and_on_forever", type: "VARCHAR" })).toBe(320);
  });

  it("orders results by their latest update with stable ties", () => {
    const ordered = cardsLatestFirst([card("new", "2026-10-09T12:00:00Z"), card("old", "2026-10-09T09:00:00Z", { updatedAt: "2026-10-09T13:00:00Z" }), card("mid", "2026-10-09T10:00:00Z")]);
    expect(ordered.map((entry) => entry.id)).toEqual(["old", "new", "mid"]);
    expect(cardsLatestFirst([card("a", "same"), card("b", "same")]).map((entry) => entry.id)).toEqual(["b", "a"]);
  });
});
