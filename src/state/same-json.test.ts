import { describe, expect, it } from "vitest";
import { sameJson } from "./same-json";

describe("sameJson", () => {
  it("takes the same data in another key order, with undefined keys left out, as the same", () => {
    expect(sameJson({ a: 1, b: { c: [1, { d: null }], e: "x" } }, { b: { e: "x", c: [1, { d: null }] }, a: 1, gone: undefined })).toBe(true);
    expect(sameJson({ gone: undefined }, {})).toBe(true);
    expect(sameJson([], [])).toBe(true);
    expect(sameJson(null, null)).toBe(true);
  });

  it("tells any difference in a value, a key or a list apart", () => {
    expect(sameJson({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameJson({ a: 1 }, { a: 1, b: false })).toBe(false);
    expect(sameJson({ a: 1, b: null }, { a: 1 })).toBe(false);
    expect(sameJson({ a: undefined, b: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameJson([1, 2], [2, 1])).toBe(false);
    expect(sameJson([1], [1, 2])).toBe(false);
    expect(sameJson([], {})).toBe(false);
    expect(sameJson({ 0: "a", length: 1 }, ["a"])).toBe(false);
    expect(sameJson(null, {})).toBe(false);
    expect(sameJson("1", 1)).toBe(false);
    expect(sameJson({ a: { b: [] } }, { a: { b: {} } })).toBe(false);
  });
});
