import { describe, expect, it } from "vitest";

import { DATA_CONTEXT_DRAFT_MAX_BYTES, parseDataContext } from "./data-context.ts";

const refused = (value: unknown): number | undefined => {
  try {
    parseDataContext(value);
  } catch (error) {
    return (error as { status?: number }).status;
  }
  return undefined;
};

describe("parseDataContext", () => {
  it("accepts a card id as the sheet mints them, with an optional bounded draft", () => {
    expect(parseDataContext(undefined)).toBeUndefined();
    expect(parseDataContext(null)).toBeUndefined();
    expect(parseDataContext({ cardId: "c_12" })).toEqual({ cardId: "c_12" });
    expect(parseDataContext({ cardId: "c_1", draftSql: "select 1" })).toEqual({ cardId: "c_1", draftSql: "select 1" });
    const atTheCap = "x".repeat(DATA_CONTEXT_DRAFT_MAX_BYTES);
    expect(parseDataContext({ cardId: "c_1", draftSql: atTheCap })).toEqual({ cardId: "c_1", draftSql: atTheCap });
  });

  it("refuses anything else with a 400: a table name, a foreign field, a draft past 100 KB (in bytes)", () => {
    for (const bad of [
      { cardId: "orders" }, { cardId: "c_" }, { cardId: "c_1x" }, { cardId: 1 }, {}, "c_1", [],
      { cardId: "c_1", draftSql: 1 }, { cardId: "c_1", botId: "pepper" },
      { cardId: "c_1", draftSql: "x".repeat(DATA_CONTEXT_DRAFT_MAX_BYTES + 1) },
      // one multi-byte character over the cap, though its length is under it
      { cardId: "c_1", draftSql: `${"x".repeat(DATA_CONTEXT_DRAFT_MAX_BYTES - 1)}é` },
    ]) {
      expect(refused(bad), JSON.stringify(bad).slice(0, 60)).toBe(400);
    }
  });
});
