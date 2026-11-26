import { describe, expect, it } from "vitest";
import { bulkDeleteThreadIds, outsideClosedScope } from "./bulk-delete.ts";

describe("bulkDeleteThreadIds scope", () => {
  it("defaults to every listed thread and accepts a closed-only scope", () => {
    expect(bulkDeleteThreadIds({ threadIds: ["a", "a", "b"] })).toEqual({ ok: true, threadIds: ["a", "b"], scope: "all" });
    expect(bulkDeleteThreadIds({ threadIds: ["a"], scope: "closed" })).toEqual({ ok: true, threadIds: ["a"], scope: "closed" });
  });

  it("refuses an unknown scope", () => {
    expect(bulkDeleteThreadIds({ threadIds: ["a"], scope: "open" })).toMatchObject({ ok: false });
    expect(bulkDeleteThreadIds({ threadIds: ["a"], scope: 1 })).toMatchObject({ ok: false });
  });
});

describe("outsideClosedScope", () => {
  const closedBy = { botId: "helper", name: "Helper", at: 1 };
  it("lets only a closed, unpinned thread through", () => {
    expect(outsideClosedScope({ closedBy })).toBe(false);
    expect(outsideClosedScope({ closedBy, pinned: true })).toBe(true);
    expect(outsideClosedScope({})).toBe(true);
    expect(outsideClosedScope(null)).toBe(true);
    expect(outsideClosedScope(undefined)).toBe(true);
  });
});
