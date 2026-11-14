import { describe, expect, it } from "vitest";
import { tableIdentifierParts } from "./identifiers.ts";

describe("table identifier parts", () => {
  it.each([
    ["sales", ["sales"]],
    [" café ", ["café"]],
    [' main . " 分析 " ', ["main", " 分析 "]],
    ['"catalog.name"."schema"."x""y"', ["catalog.name", "schema", 'x"y']],
    ['" select from x "', [" select from x "]],
    ['"line\nbreak"', ["line\nbreak"]],
  ] as const)("preserves the meaning of %j", (input, expected) => {
    expect(tableIdentifierParts(input)).toEqual(expected);
  });

  it.each(["", '""', '"unfinished', "main.", "main. ", "a..b", "a.b.c.d", '"name"suffix', "SELECT * FROM t", "(SELECT 1)", "x; SELECT 1", "read_csv('x')"])("does not classify %j as a table identifier", (input) => {
    expect(tableIdentifierParts(input)).toBeNull();
  });
});
