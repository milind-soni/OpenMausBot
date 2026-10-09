import { describe, expect, it } from "vitest";
import { parseTableFile, tableCsv, tableDelimiter, tableRowOrder } from "./table-data";

describe("table data", () => {
  it("parses quoted CSV, embedded newlines, escaped quotes, BOM, CRLF and leading zeroes", () => {
    expect(parseTableFile('\uFEFFID,Notes\r\n001,"line one\nline two, ""quoted"""\r\n', ",")).toEqual({ headers: ["ID", "Notes"], rows: [["001", 'line one\nline two, "quoted"']] });
    expect(parseTableFile("name\tvalue\nA\t0002", "\t").rows).toEqual([["A", "0002"]]);
  });
  it("does not silently lose malformed or excessive data", () => {
    expect(() => parseTableFile('a,b\n"unclosed,b', ",")).toThrow("format");
    expect(() => parseTableFile("a,b\n1,2,3", ",")).toThrow("columns");
    expect(() => parseTableFile("a,b\n1", ",")).toThrow("columns");
    expect(() => parseTableFile("a\0", ",")).toThrow("format");
    expect(() => parseTableFile(Array(201).fill("column").join(","), ",")).toThrow("size");
    expect(() => parseTableFile("a\n" + "row\n".repeat(100_001), ",")).toThrow("size");
  });
  it("handles empty and header-only files", () => {
    expect(parseTableFile("", ",")).toEqual({ headers: [], rows: [] });
    expect(parseTableFile("A,B\n", ",")).toEqual({ headers: ["A", "B"], rows: [] });
  });
  it("searches all rows, sorts numerically, keeps empty cells last and resets to source order", () => {
    const rows = [["A", "10"], ["B", "2"], ["C", ""], ["D", "-1"], ["E", "2"]];
    expect(tableRowOrder(rows, "", { column: 1, descending: false })).toEqual([3, 1, 4, 0, 2]);
    expect(tableRowOrder(rows, "", { column: 1, descending: true })).toEqual([0, 1, 4, 3, 2]);
    expect(tableRowOrder(rows, " b ", null)).toEqual([1]);
    expect(tableRowOrder(rows, "", null)).toEqual([0, 1, 2, 3, 4]);
  });
  it("exports all results with quoting and spreadsheet formula escaping", () => {
    const rows = Array.from({ length: 2000 }, (_, i) => [String(i), i === 1999 ? '=HYPERLINK("bad")' : "A,B"]);
    const exported = parseTableFile(tableCsv(["ID", "Value"], rows), ",");
    expect(exported.rows).toHaveLength(2000);
    expect(exported.rows[1999]).toEqual(["1999", '\'=HYPERLINK("bad")']);
    expect(exported.rows[0]).toEqual(["0", "A,B"]);
  });
  it("sorts long integer IDs without losing precision", () => {
    expect(tableRowOrder([["9007199254740993"], ["9007199254740992"], ["-9007199254740993"]], "", { column: 0, descending: false })).toEqual([2, 1, 0]);
  });
  it("recognizes only supported file extensions", () => {
    expect(tableDelimiter("Report.CSV")).toBe(",");
    expect(tableDelimiter("report.tsv")).toBe("\t");
    expect(tableDelimiter("report.csv.exe")).toBeNull();
    expect(tableDelimiter("report.xlsx")).toBeNull();
  });
});
