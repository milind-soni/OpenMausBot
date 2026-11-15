import { describe, expect, it } from "vitest";

import { tableRowOrder } from "./table-data";

describe("numeric table order without floating-point loss", () => {
  it.each([
    ["9007199254740992.2", "9007199254740992.1"],
    ["1.00000000000000000002", "1.00000000000000000001"],
    ["-1.00000000000000000001", "-1.00000000000000000002"],
    ["1e309", "2e308"],
    ["-2e308", "-1e309"],
    ["2e-400", "1e-400"],
    ["-1e-400", "-2e-400"],
    ["1e9007199254740993", "1e9007199254740992"],
  ])("puts %s after %s in ascending order", (larger, smaller) => {
    const rows = [[larger], [smaller], [""], [" "]];
    expect(tableRowOrder(rows, "", { column: 0, descending: false })).toEqual([1, 0, 2, 3]);
    expect(tableRowOrder(rows, "", { column: 0, descending: true })).toEqual([0, 1, 2, 3]);
  });

  it("keeps equal values in source order across decimal and exponent spellings", () => {
    const rows = [["1.20"], ["12e-1"], ["+001.2000"], [".12e1"], ["1.2"]];
    for (const descending of [false, true]) {
      expect(tableRowOrder(rows, "", { column: 0, descending })).toEqual([0, 1, 2, 3, 4]);
    }
  });

  it("orders signed zero between tiny negative and positive values", () => {
    const rows = [["-0"], ["0e999999999999999999999"], ["1e-9999"], ["-1e-9999"], ["+0.0"]];
    expect(tableRowOrder(rows, "", { column: 0, descending: false })).toEqual([3, 0, 1, 4, 2]);
  });

  it("compares matching decimal magnitudes without expanding their exponents", () => {
    const rows = [["120001e9999"], ["12e10003"], ["123e10002"], ["12299e10000"]];
    expect(tableRowOrder(rows, "", { column: 0, descending: false })).toEqual([1, 0, 3, 2]);
  });
});
