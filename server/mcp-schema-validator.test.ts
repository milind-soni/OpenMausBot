import { describe, expect, it } from "vitest";
import { compileToolSchema } from "./mcp-schema-validator.ts";

describe("compileToolSchema", () => {
  it("accepts the numeric formats Rust's schemars writes and checks their ranges", () => {
    const validate = compileToolSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema", type: "object",
      properties: { limit: { type: "integer", format: "uint" }, depth: { type: "integer", format: "uint8" }, score: { type: "number", format: "float" }, offset: { type: "integer", format: "int32" } },
    });
    expect(validate({ limit: 10, depth: 3, score: 0.5, offset: -2 })).toBe(true);
    expect(validate({ depth: 256 })).toBe(false);
    expect(validate({ limit: -1 })).toBe(false);
    expect(validate({ offset: 2147483648 })).toBe(false);
  });

  it("holds every integer format to its range, with 64-bit ones capped at the safe integer", () => {
    const cases: Array<[string, number, number]> = [
      ["int8", -128, 127], ["int16", -32768, 32767], ["int32", -2147483648, 2147483647], ["int64", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
      ["int", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER], ["int128", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
      ["uint", 0, Number.MAX_SAFE_INTEGER], ["uint128", 0, Number.MAX_SAFE_INTEGER], ["uint8", 0, 255], ["uint16", 0, 65535], ["uint32", 0, 4294967295], ["uint64", 0, Number.MAX_SAFE_INTEGER],
    ];
    for (const [format, min, max] of cases) {
      const validate = compileToolSchema({ type: "object", properties: { n: { type: "integer", format } } });
      expect([validate({ n: min }), validate({ n: max }), validate({ n: min - 1 }), validate({ n: max + 1 }), validate({ n: 1.5 })], format).toEqual([true, true, false, false, false]);
    }
    const double = compileToolSchema({ type: "object", properties: { x: { type: "number", format: "double" } } });
    expect([double({ x: -1e300 }), double({ x: 0.25 })]).toEqual([true, true]);
  });

  it("still refuses a format it does not know", () => {
    expect(() => compileToolSchema({ type: "object", properties: { x: { type: "string", format: "made-up" } } })).toThrow("could not be validated");
  });
});
