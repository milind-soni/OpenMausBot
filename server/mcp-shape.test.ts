import { describe, expect, it } from "vitest";

import { QUERY_TOOL, QUERY_TOOL_NAME, ResultStore, answerQuery, describeShape } from "./mcp-shape.ts";

const product = (i: number) => ({ id: `p${i}`, name: `Protein Bar ${i}`, price: 199 + i, blurb: "x".repeat(300) });

describe("describeShape", () => {
  it("names the top-level keys and the size and item keys of each array", () => {
    const shape = describeShape({ nextOffset: "1", products: Array.from({ length: 312 }, (_, i) => product(i)) });
    expect(shape).toBe("object{nextOffset, products}; products: 312 items{id, name, price, blurb}");
  });

  it("describes a bare array and caps a long key list", () => {
    const wide = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
    expect(describeShape([wide, wide])).toBe("2 items{k0, k1, k2, k3, k4, k5, k6, k7, k8, k9, k10, k11, …}");
    expect(describeShape([1, 2, 3])).toBe("3 items");
    expect(describeShape("plain")).toBe("string");
  });
});

describe("ResultStore", () => {
  it("hands out short handles and returns what it holds", () => {
    const store = new ResultStore();
    const value = { products: [product(1)] };
    const handle = store.put("search_products", value);
    expect(handle).toBe("r1");
    expect(store.put("search_products", value)).toBe("r2");
    expect(store.get("r1")).toEqual({ tool: "search_products", value });
    expect(store.get("r9")).toBeUndefined();
  });

  it("drops the oldest result once the held bytes pass its capacity", () => {
    const store = new ResultStore({ maxBytes: 2_000 });
    const first = store.put("a", { blurb: "x".repeat(900) });
    const second = store.put("b", { blurb: "x".repeat(900) });
    const third = store.put("c", { blurb: "x".repeat(900) });
    expect(store.get(first)).toBeUndefined();
    expect(store.get(second)).toBeDefined();
    expect(store.get(third)).toBeDefined();
  });
});

describe("answerQuery", () => {
  const store = new ResultStore();
  const handle = store.put("search_products", { nextOffset: "1", products: Array.from({ length: 300 }, (_, i) => product(i)) });

  it("returns only what the query selects", () => {
    const answer = answerQuery(store, { result: handle, query: "products[?price < `202`].{name: name, price: price}" }, 8_000);
    expect(answer.isError).toBeUndefined();
    expect(JSON.parse(answer.content[0]!.text)).toEqual([
      { name: "Protein Bar 0", price: 199 }, { name: "Protein Bar 1", price: 200 }, { name: "Protein Bar 2", price: 201 },
    ]);
  });

  it("cuts an answer that is itself too big, so the whole result never comes back", () => {
    const answer = answerQuery(store, { result: handle, query: "@" }, 2_000);
    expect(answer.content[0]!.text.length).toBeLessThan(2_400);
    expect(answer.content[0]!.text).toContain("TRUNCATED by OpenMausBot");
    expect(answer.content[0]!.text).toContain(`"${handle}"`);
  });

  it("explains a query it cannot parse and shows the shape to query against", () => {
    const answer = answerQuery(store, { result: handle, query: "products[?price <" }, 8_000);
    expect(answer.isError).toBe(true);
    expect(answer.content[0]!.text).toContain("Invalid token");
    expect(answer.content[0]!.text).toContain("products: 300 items{id, name, price, blurb}");
  });

  it("tells the model to call the tool again when a handle is gone", () => {
    const answer = answerQuery(store, { result: "r77", query: "@" }, 8_000);
    expect(answer.isError).toBe(true);
    expect(answer.content[0]!.text).toContain("no longer held");
    expect(answer.content[0]!.text).toContain("call the original tool again");
  });

  it("rejects arguments that are not a handle and a query", () => {
    expect(answerQuery(store, { result: 3, query: "@" }, 8_000).isError).toBe(true);
    expect(answerQuery(store, { result: handle }, 8_000).isError).toBe(true);
    expect(answerQuery(store, null, 8_000).isError).toBe(true);
  });

  it("answers a query that selects nothing with null, not an error", () => {
    const answer = answerQuery(store, { result: handle, query: "nope.missing" }, 8_000);
    expect(answer.isError).toBeUndefined();
    expect(answer.content[0]!.text).toBe("null");
  });
});

describe("QUERY_TOOL", () => {
  it("is a read-only tool whose schema asks for a handle and a JMESPath query", () => {
    expect(QUERY_TOOL.name).toBe(QUERY_TOOL_NAME);
    expect(QUERY_TOOL_NAME).toBe("query_result");
    expect(QUERY_TOOL.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    expect(QUERY_TOOL.inputSchema).toMatchObject({ type: "object", required: ["result", "query"] });
    expect(QUERY_TOOL.description).toContain("JMESPath");
  });
});
