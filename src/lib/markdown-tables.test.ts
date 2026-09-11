import { describe, expect, it } from "vitest";

import { repairMarkdownTables } from "./markdown-tables";

const lines = (text: string) => text.split("\n");

describe("repairMarkdownTables", () => {
  it.each([
    "Pros | Cons\n---",
    "Example:\n\n    | A | B |\n    |---|",
    "Example:\n\n\t| A | B |\n\t|---|",
    "Example: `| A | B | |---|---| | 1 | 2 |`",
    "````md\n```\n| A | B | |---|---| | 1 | 2 |\n````",
    "> ```md\n> | A | B | |---|---| | 1 | 2 |\n> ```",
    "- intro\n  | A | B |\n  |---|\n  | 1 | 2 |",
    "| a \\| b | c |\n| --- | --- |\n| 1 | 2 |",
    "| A | B |\n| --- | --- |\n| a | b |---|---|",
    "| A | B | --- | --- |\n| --- | --- | --- | --- |\n| 1 | 2 | 3 | 4 |",
  ])("preserves existing Markdown structure: %s", (text) => {
    expect(repairMarkdownTables(text)).toBe(text);
  });

  it("preserves real empty cells at the beginning of run-on rows", () => {
    expect(lines(repairMarkdownTables("| A | B | |---|---| | | 2 | | | 4 |"))).toEqual([
      "| A | B |", "| --- | --- |", "|  | 2 |", "|  | 4 |",
    ]);
  });

  it("preserves alignment when splitting a run-on table", () => {
    expect(lines(repairMarkdownTables("| A | B | |:---|---:| | 1 | 2 |"))[1]).toBe("| :--- | ---: |");
  });

  it("keeps incomplete fenced examples unchanged at every streaming prefix", () => {
    const text = "````md\n```\n| A | B | |---|---| | 1 | 2 |\n````";
    for (let end = 1; end <= text.length; end++) {
      expect(repairMarkdownTables(text.slice(0, end))).toBe(text.slice(0, end));
    }
  });

  it("leaves text without pipes untouched", () => {
    const text = "A paragraph — no table here.\n\n- a list item\n- another";
    expect(repairMarkdownTables(text)).toBe(text);
  });

  it("leaves a well-formed table untouched", () => {
    const text = "intro\n\n| A | B |\n| --- | --- |\n| 1 | 2 |";
    expect(repairMarkdownTables(text)).toBe(text);
  });

  it("pads a delimiter row that is one cell short of the header", () => {
    const text = "| A | B | C |\n|---|---|\n| 1 | 2 | 3 |";
    expect(lines(repairMarkdownTables(text))[1]).toBe("| --- | --- | --- |");
  });

  it("repairs delimiter rows without optional outer pipes", () => {
    expect(repairMarkdownTables("A | B | C\n--- | ---\n1 | 2 | 3")).toBe("A | B | C\n| --- | --- | --- |\n1 | 2 | 3");
  });

  it("trims a delimiter row that has more cells than the header", () => {
    const text = "| A | B |\n|---|---|---|---|\n| 1 | 2 |";
    expect(lines(repairMarkdownTables(text))[1]).toBe("| --- | --- |");
  });

  it("keeps the alignment the model supplied while padding the rest", () => {
    const text = "| A | B | C |\n|:--|--:|\n| 1 | 2 | 3 |";
    expect(lines(repairMarkdownTables(text))[1]).toBe("| :-- | --: | --- |");
  });

  it("inserts the blank line a table needs to escape the paragraph above it", () => {
    const text = "Lead-in prose\n| A | B |\n| --- | --- |\n| 1 | 2 |";
    expect(lines(repairMarkdownTables(text))).toEqual([
      "Lead-in prose",
      "",
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
    ]);
  });

  it("splits a table that arrived on a single line", () => {
    const text = "| A | B | |---|---| | 1 | 2 | | 3 | 4 |";
    expect(lines(repairMarkdownTables(text))).toEqual([
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "| 3 | 4 |",
    ]);
  });

  it("pads a trailing row that is still streaming in", () => {
    const text = "| A | B | |---|---| | 1 | 2 | | 3 |";
    expect(lines(repairMarkdownTables(text)).at(-1)).toBe("| 3 |  |");
  });

  it("repairs the run-on research table verbatim from a bot message", () => {
    // Nine headers, an eight-cell delimiter, every row welded onto one line —
    // the shape that rendered as a wall of pipes in an Anchor report.
    const text = [
      "India — core research / screener / filings",
      "| Company | What they sell | Round | Amount | Investors | Post-money if public | Date | India/G | Source |",
      "|---|---|---|---|---|---|---|---|",
      "| **Kalpi** | Quant baskets | Seed | ₹3.75 Cr | Rainmatter | $2.82M | 19 May 2026 | India | Inc42 |",
    ].join("\n");
    const repaired = lines(repairMarkdownTables(text));
    expect(repaired[0]).toBe("India — core research / screener / filings");
    expect(repaired[1]).toBe("");
    // header and delimiter now agree at nine cells, so GFM builds a table
    expect(repaired[3]).toBe("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    expect(repaired[4]).toContain("**Kalpi**");
  });

  it("never rewrites pipes inside a fenced code block", () => {
    const text = "```sh\n| A | B | |---|---| | 1 | 2 |\n```";
    expect(repairMarkdownTables(text)).toBe(text);
  });

  it("leaves prose that merely contains a dashed run alone", () => {
    const text = "The separator |---|---| is what GFM calls a delimiter row.";
    expect(repairMarkdownTables(text)).toBe(text);
  });

  it("leaves a two-cell aside alone", () => {
    const text = "ship | hold";
    expect(repairMarkdownTables(text)).toBe(text);
  });
});
