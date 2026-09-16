// Phase 4 part 2: freshness and consolidation, pure. Parsing the notebook,
// the confirmed stamp, the plan (duplicates, contradictions, stale lines,
// the floor) and applying it.
import { describe, expect, it } from "vitest";
import { applyPlan, confirmedDate, consolidatorPrompt, duplicateIndexes, parseContradictions, parseNotebook, planConsolidation, stampConfirmed } from "./consolidate.ts";

const TODAY = "2026-09-16";
const NOTEBOOK = [
  "# Notes",
  "- 2026-09-01 · from chat \"a\" · importance 3 · We ship on Fridays",
  "- 2026-09-10 · from chat \"b\", captured · we ship on fridays.",
  "- 2026-09-12 · from chat \"c\" · We do not ship on Fridays",
  "- 2025-01-01 · from chat \"d\" · importance 1 · The office plant is called Fred",
  "- 2026-09-15 · from chat \"e\" · importance 5 · The database is called moonbase",
  "- ~~old thing~~ · superseded 2026-09-02",
  "hand-written line without a date",
].join("\n");

describe("parsing", () => {
  it("reads dated entries with body, date, importance and strike-through; leaves other lines alone", () => {
    const entries = parseNotebook(NOTEBOOK);
    expect(entries.map((e) => e.body)).toEqual(["We ship on Fridays", "we ship on fridays.", "We do not ship on Fridays", "The office plant is called Fred", "The database is called moonbase"]);
    expect(entries[0]).toMatchObject({ line: 1, date: "2026-09-01", importance: 3, struck: false });
    expect(entries[3].importance).toBe(1);
  });
  it("reads and writes the confirmed stamp", () => {
    const line = "- 2026-09-01 · from chat \"a\" · We ship on Fridays";
    expect(confirmedDate(line)).toBeNull();
    const stamped = stampConfirmed(line, TODAY);
    expect(stamped).toBe("- 2026-09-01 · from chat \"a\" · We ship on Fridays · confirmed 2026-09-16");
    expect(confirmedDate(stamped)).toBe(TODAY);
    expect(stampConfirmed(stamped, "2026-09-17")).toBe("- 2026-09-01 · from chat \"a\" · We ship on Fridays · confirmed 2026-09-17");
  });
});

describe("the plan", () => {
  it("merges duplicates onto the newest, strikes the loser of a contradiction, archives stale low-importance lines, keeps the rest", () => {
    const entries = parseNotebook(NOTEBOOK);
    // entries: [0] ship Fridays (Sep 1) · [1] ship fridays, captured (Sep 10) · [2] do NOT ship (Sep 12) · [3] plant (2025, importance 1) · [4] moonbase (importance 5)
    const plan = planConsolidation(entries, { today: TODAY, staleDays: 90, floorShare: 0.8, contradictions: [{ a: 1, b: 2, keep: "b" }] }); // five live entries, room for four changes
    expect(plan.removeDuplicate).toEqual([0]); // the older duplicate goes, the captured newer one stays
    expect(plan.supersede).toEqual([{ loser: 1, winner: 2 }]);
    expect(plan.archive).toEqual([3]);
    expect(plan.overFloor).toBe(false);
  });
  it("stops at the floor: never more than the share of entries in one pass", () => {
    const entries = parseNotebook(NOTEBOOK);
    const plan = planConsolidation(entries, { today: TODAY, staleDays: 90, floorShare: 0.2, contradictions: [{ a: 1, b: 2, keep: "b" }] });
    // five entries → at most one change
    expect(plan.removeDuplicate.length + plan.supersede.length + plan.archive.length).toBe(1);
    expect(plan.overFloor).toBe(true);
  });
  it("never touches importance 5 or confirmed lines as stale", () => {
    const text = [
      "- 2025-01-01 · from chat \"x\" · importance 5 · Keep me",
      "- 2025-01-01 · from chat \"y\" · importance 1 · Keep me too · confirmed 2026-09-10",
      "- 2025-01-01 · from chat \"z\" · importance 1 · Archive me",
    ].join("\n");
    const plan = planConsolidation(parseNotebook(text), { today: TODAY, staleDays: 90, floorShare: 1, contradictions: [] });
    expect(plan.archive).toEqual([2]);
  });
});

describe("applying", () => {
  it("rewrites the file: duplicates gone, the loser struck with a trace, stale lines moved to the archive", () => {
    const entries = parseNotebook(NOTEBOOK);
    const plan = planConsolidation(entries, { today: TODAY, staleDays: 90, floorShare: 1, contradictions: [{ a: 1, b: 2, keep: "b" }] });
    const result = applyPlan(NOTEBOOK, entries, plan, TODAY);
    expect(result.text).not.toContain("importance 3 · We ship on Fridays\n");
    expect(result.text).toMatch(/~~we ship on fridays\.~~ · superseded 2026-09-16/);
    expect(result.text).toContain("We do not ship on Fridays");
    expect(result.text).not.toContain("office plant");
    expect(result.archived).toEqual(["- 2025-01-01 · from chat \"d\" · importance 1 · The office plant is called Fred · archived 2026-09-16"]);
    expect(result.text).toContain("hand-written line without a date");
    expect(result.text).toContain("# Notes");
  });
});

describe("the contradiction call", () => {
  it("numbers the entries and reads back pairs, dropping bad indexes", () => {
    const entries = parseNotebook(NOTEBOOK);
    const prompt = consolidatorPrompt(entries);
    expect(prompt).toContain("You are the CONSOLIDATOR");
    expect(prompt).toMatch(/\[0\] We ship on Fridays/);
    // asked after dedupe: the older copy is left out, the survivor keeps its index
    expect(duplicateIndexes(entries)).toEqual(new Set([0]));
    const deduped = consolidatorPrompt(entries, duplicateIndexes(entries));
    expect(deduped).not.toMatch(/\[0\] We ship on Fridays/);
    expect(deduped).toMatch(/\[1\] we ship on fridays\./);
    const pairs = parseContradictions('{"pairs": [{"a": 1, "b": 2, "keep": "b"}, {"a": 9, "b": 1, "keep": "a"}, {"a": 2, "b": 2, "keep": "a"}]}', entries.length);
    expect(pairs).toEqual([{ a: 1, b: 2, keep: "b" }]);
    expect(parseContradictions("nothing here", 5)).toEqual([]);
  });
});
