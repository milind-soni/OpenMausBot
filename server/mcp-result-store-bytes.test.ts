import { describe, expect, it } from "vitest";

import { ResultStore } from "./mcp-shape.ts";

describe("held result byte accounting", () => {
  it.each(["界", "é", "😀"])("counts UTF-8 bytes for %s when deciding which result to evict", (character) => {
    const value = { text: character.repeat(100) };
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    const store = new ResultStore({ maxBytes: bytes * 2 - 1 });
    const first = store.put("search", value);
    const second = store.put("search", value);
    expect(store.get(first)).toBeUndefined();
    expect(store.get(second)).toEqual({ tool: "search", value });
  });

  it("keeps results exactly at the byte budget", () => {
    const value = { text: "界".repeat(100) };
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    const store = new ResultStore({ maxBytes: bytes * 2 });
    const first = store.put("search", value);
    const second = store.put("search", value);
    expect(store.get(first)).toBeDefined();
    expect(store.get(second)).toBeDefined();
  });

  it("uses the caller's serialized byte size, including whitespace", () => {
    const value = { text: "界" };
    const bytes = Buffer.byteLength(JSON.stringify(value, null, 2), "utf8");
    const store = new ResultStore({ maxBytes: bytes * 2 - 1 });
    const first = store.put("search", value, bytes);
    const second = store.put("search", value, bytes);
    expect(store.get(first)).toBeUndefined();
    expect(store.get(second)).toBeDefined();
  });
});
