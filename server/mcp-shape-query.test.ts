import { describe, expect, it } from "vitest";

import { ResultStore, answerQuery, exampleQuery } from "./mcp-shape.ts";

describe("generated query_result examples", () => {
  it.each(["line-items", "line items", "123items", "商品", "", "a.b", "a\"b", "a\\b", "a\nb"])(
    "selects an array whose key is %j",
    (key) => {
      const value = { [key]: [{ name: "first", price: 12 }] };
      const store = new ResultStore();
      const handle = store.put("list", value);
      const result = answerQuery(store, { result: handle, query: exampleQuery(value) }, 8_000);
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0]!.text)).toEqual(value[key]);
    },
  );

  it.each(["unit-price", "display name", "123", "名称", "", "a.b", "a\"b", "a\\b", "a\nb"])(
    "preserves a projected field whose key is %j",
    (key) => {
      const value = [{ [key]: "first", count: 12, omitted: true }];
      const store = new ResultStore();
      const handle = store.put("list", value);
      const result = answerQuery(store, { result: handle, query: exampleQuery(value) }, 8_000);
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0]!.text)).toEqual([{ [key]: "first", count: 12 }]);
    },
  );

  it("keeps simple identifiers readable", () => {
    expect(exampleQuery({ items: [{ name: "first", price: 12 }] }))
      .toBe("items[0:20].{name: name, price: price}");
  });

  it("returns a usable slice for empty record arrays", () => {
    const value = [{}, {}];
    const store = new ResultStore();
    const handle = store.put("list", value);
    const result = answerQuery(store, { result: handle, query: exampleQuery(value) }, 8_000);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toEqual(value);
  });
});
