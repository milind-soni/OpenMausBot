import { describe, expect, it } from "vitest";
import { boundedContextText, selectReplay, type ReplayEntry } from "./context-rebuild.ts";

const entries = (texts: string[]): ReplayEntry[] => texts.map((text, i) => ({ id: String(i), role: i % 2 ? "assistant" : "user", text }));
const size = (result: ReturnType<typeof selectReplay>) => result.transcript.reduce((n, entry) => n + Buffer.byteLength(entry.text) + 16, 0);

describe("context replay", () => {
  it("keeps short history unchanged and records exactly what was represented", () => {
    const history = entries(["one", "reply", "two"]);
    const result = selectReplay(history);
    expect(result.transcript).toEqual(history);
    expect(result.representedIds).toEqual(history.map(entry => entry.id));
    expect(result.dropped).toBe(0);
  });

  it("uses byte and message bounds without falsely crediting dropped messages", () => {
    const history = entries(Array.from({ length: 80 }, (_, i) => `${i} ${"long 🐭 text ".repeat(50)}`));
    const result = selectReplay(history, { budgetBytes: 2_048, maxMessages: 40 });
    expect(size(result)).toBeLessThanOrEqual(2_048);
    expect(result.dropped).toBeGreaterThan(0);
    expect(new Set(result.representedIds)).toEqual(new Set(result.transcript.filter(entry => entry.id).map(entry => entry.id)));
    expect(result.representedIds).not.toContain("0");
    expect(result.representedIds).toContain("79");
  });

  it("counts the summary and omission notice against the budget", () => {
    const history = entries(["old", "old reply", "retained", "reply", ""]);
    const result = selectReplay(history, { budgetBytes: 1_024, compaction: {
      id: "4", firstKeptId: "2", foldedThroughId: "1", summary: "large 🐭 summary ".repeat(1_000), by: "harness", tokensBefore: 100,
    } });
    expect(size(result)).toBeLessThanOrEqual(1_024);
    expect(result.compacted).toBe(2);
    expect(new Set(result.representedIds)).toEqual(new Set(["0", "1", "2", "3", "4"]));
    expect(result.transcript[0]!.text).toContain("historical data");
  });

  it("ignores records whose anchors no longer belong to the selected branch", () => {
    const history = entries(["corrected history", "answer", "keep", ""]);
    const result = selectReplay(history, { compaction: {
      id: "3", firstKeptId: "2", foldedThroughId: "abandoned-id", summary: "obsolete request", by: "harness", tokensBefore: 100,
    } });
    expect(result.compacted).toBe(0);
    expect(result.transcript.map(entry => entry.text)).toContain("corrected history");
    expect(JSON.stringify(result.transcript)).not.toContain("obsolete request");
  });

  it("finds the compaction boundary before excluding the turn's own request", () => {
    const result = selectReplay(entries(["old", "reply", "current", ""]), {
      excludedIds: new Set(["2"]), compaction: { id: "3", firstKeptId: "2", foldedThroughId: "1", summary: "old summary", by: "person", tokensBefore: 1 },
    });
    expect(result.compacted).toBe(2);
    expect(result.representedIds).not.toContain("2");
    expect(result.transcript).toHaveLength(1);
  });

  it("bounds a single oversized history entry, preserving both ends and an honest notice", () => {
    const result = selectReplay(entries([`START ${"🐭".repeat(10_000)} CANCELLED_AT_END`]), { budgetBytes: 1_024 });
    expect(size(result)).toBeLessThanOrEqual(1_024);
    expect(result.shortened).toEqual(["0"]);
    expect(result.transcript[0]!.text).toMatch(/^START /);
    expect(result.transcript[0]!.text).toContain("Text shortened");
    expect(result.transcript[0]!.text).toMatch(/CANCELLED_AT_END$/);
    expect(result.transcript[0]!.text).not.toContain("�");
  });

  it("a full manual fold retains later messages without a future boundary id", () => {
    const result = selectReplay(entries(["old", "reply", "", "new question", "new answer"]), {
      compaction: { id: "2", firstKeptId: "", foldedThroughId: "1", summary: "old summary", by: "person", tokensBefore: 1 },
    });
    expect(result.compacted).toBe(2);
    expect(result.transcript.slice(1).map(entry => entry.text)).toEqual(["new question", "new answer"]);
    expect(new Set(result.representedIds)).toEqual(new Set(["0", "1", "2", "3", "4"]));
  });

  it("bounds UTF-8 text at every possible split", () => {
    const text = "start 你好🐭".repeat(100);
    for (let limit = 0; limit < 300; limit++) {
      const result = boundedContextText(text, limit);
      expect(Buffer.byteLength(result)).toBeLessThanOrEqual(limit);
      expect(result).not.toContain("�");
    }
  });

  it.each([NaN, Infinity, -1, 0, 512, 1_024.5])("rejects an invalid budget %s", (budgetBytes) => {
    expect(() => selectReplay([], { budgetBytes })).toThrow("invalid context");
  });
});
