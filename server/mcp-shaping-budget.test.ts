import { describe, expect, it } from "vitest";

import { ResultStore, answerQuery } from "./mcp-shape.ts";

const wideResult = () => Object.fromEntries(Array.from({ length: 80 }, (_, index) => [
  `field_${index}_${"x".repeat(100)}`,
  Array.from({ length: 20 }, (_, id) => ({ id, text: "payload".repeat(20) })),
]));

describe("held-result metadata obeys the query budget", () => {
  it.each([512, 2_000, 8_000])("bounds a successful wide query to %i characters", budget => {
    const store = new ResultStore();
    const value = wideResult();
    const handle = store.put("wide_search", value);
    const answer = answerQuery(store, { result: handle, query: "@" }, budget);
    expect(answer.isError).toBeUndefined();
    expect(answer.content[0]!.text.length).toBeLessThanOrEqual(budget);
    expect(answer.content[0]!.text).toContain("TRUNCATED by OpenMausBot");
    expect(answer.content[0]!.text).toContain(`"${handle}"`);
    expect(answer.content[0]!.text).toContain("Narrow the query");
    expect(store.get(handle)!.value).toBe(value);
    expect(answerQuery(store, { result: handle, query: "length(keys(@))" }, budget).content[0]!.text).toBe("80");
  });

  it.each([512, 2_000, 8_000])("bounds the shape in a query error to %i characters", budget => {
    const store = new ResultStore();
    const handle = store.put("wide_search", wideResult());
    const answer = answerQuery(store, { result: handle, query: "[?" }, budget);
    expect(answer.isError).toBe(true);
    expect(answer.content[0]!.text.length).toBeLessThanOrEqual(budget);
    expect(answer.content[0]!.text).toContain("Invalid JMESPath query");
    expect(answerQuery(store, { result: handle, query: "length(keys(@))" }, budget).content[0]!.text).toBe("80");
  });

  it("bounds an unknown handle echoed into an error", () => {
    const answer = answerQuery(new ResultStore(), { result: "r".repeat(20_000), query: "@" }, 512);
    expect(answer.isError).toBe(true);
    expect(answer.content[0]!.text.length).toBeLessThanOrEqual(512);
  });

  it("keeps a small diagnostic and selected JSON unchanged", () => {
    const store = new ResultStore();
    const value = { items: [{ id: 1, title: "中文🙂" }] };
    const handle = store.put("search", value);
    expect(answerQuery(store, { result: handle, query: "@" }, 512)).toEqual({ content: [{ type: "text", text: JSON.stringify(value) }] });
    const invalid = answerQuery(store, { result: handle, query: "[?" }, 8_000);
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0]!.text.startsWith("Invalid JMESPath query")).toBe(true);
    expect(invalid.content[0]!.text).toContain("items: 1 items{id, title}");
    expect(invalid.content[0]!.text).not.toContain("TRUNCATED");
  });

  it("keeps a missing handle error readable at the minimum budget", () => {
    expect(answerQuery(new ResultStore(), { result: "r77", query: "@" }, 512)).toEqual({
      content: [{ type: "text", text: 'Result "r77" is no longer held; call the original tool again and query the new handle it gives you.' }],
      isError: true,
    });
  });
});
