import { describe, expect, it } from "vitest";

import { boundColumns, boundRows } from "./tools.ts";

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

describe("Data tool UTF-8 budgets", () => {
  it.each(["汉", "😀"])("bounds rows containing %s by their encoded bytes", (character) => {
    const rows = Array.from({ length: 20 }, () => [character.repeat(100)]);
    const bounded = boundRows(rows, 20, 2_000);
    expect(bytes(bounded.rows)).toBeLessThanOrEqual(2_000);
    expect(bounded.truncated).toBe(true);
    expect(bounded.rows.length).toBeGreaterThan(0);
    expect(bounded.rows).toEqual(rows.slice(0, bounded.rows.length));
  });

  it("bounds Unicode column names even after statistics have been removed", () => {
    const columns = Array.from({ length: 4 }, (_, index) => ({ name: `${"列".repeat(40)}${index}`, type: "VARCHAR" }));
    const bounded = boundColumns(columns, 400);
    expect(bytes(bounded.columns)).toBeLessThanOrEqual(400);
    expect(bounded.truncated).toBe(true);
    expect(bounded.columns.length).toBeGreaterThan(0);
    expect(bounded.columns).toEqual(columns.slice(0, bounded.columns.length));
  });

  it("drops a Unicode sample that exceeds the byte budget", () => {
    const bounded = boundColumns([{ name: "value", type: "VARCHAR", sample: ["汉".repeat(40)] }], 110);
    expect(bytes(bounded.columns)).toBeLessThanOrEqual(110);
    expect(bounded).toEqual({ columns: [{ name: "value", type: "VARCHAR" }], truncated: true });
  });

  it("keeps ASCII and escaped content when it fits the exact budget", () => {
    const rows = [["plain", "\"quoted\"\n\\", 7, null]];
    expect(boundRows(rows, 1, bytes(rows))).toEqual({ rows, truncated: false });
    const columns = [{ name: "value", type: "INTEGER", min: "1", max: "7" }];
    expect(boundColumns(columns, bytes(columns))).toEqual({ columns, truncated: false });
  });
});
