import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { memoryLines, mergeMemoryText } from "./cloud-send-memory.ts";
import { DATA_DIR } from "./config.ts";
import { adoptMemoryJournal, flushMemoryJournal, journalFile, readMemoryJournal, recordMemoryChange, type MemoryJournalEntry } from "./memory-journal.ts";
import { adoptLearned, learnedState } from "./profile-learned.ts";
import { TeamMemory } from "./team-memory.ts";

describe("a memory file merged into My Cloud's", () => {
  const theirs = "# Notes\n- 2026-10-05 · from chat · Acme pays on the 5th. · updated 2026-10-06\n- 2026-10-04 · from chat · Prefers email.\n";
  const mine = "# Notes\n- 2026-10-01 · from chat · Acme pays on the 5th.\n- 2026-10-02 · from chat · Ship on Fridays.\n  with a second line\n- 2026-10-03 · from chat · ~~Old address~~ · superseded 2026-10-04\n";

  it("adds only the pieces My Cloud lacks, after its own and in order, each fact once however it was dated or marked", () => {
    const merged = mergeMemoryText(theirs, mine);
    expect(merged).toBe(`${theirs}- 2026-10-02 · from chat · Ship on Fridays.\n  with a second line\n- 2026-10-03 · from chat · ~~Old address~~ · superseded 2026-10-04\n`);
    expect(mergeMemoryText(merged, mine), "merging again changes nothing").toBe(merged);
    expect(mergeMemoryText("", mine), "a file My Cloud lacks arrives as it is").toBe(mine);
    expect(mergeMemoryText(theirs, theirs)).toBe(theirs);
  });

  it("keeps My Cloud's own front matter, and takes this computer's when it has none", () => {
    const front = "---\ntitle: Clients\n---\n";
    expect(mergeMemoryText(`${front}- 2026-10-01 · from chat · A.\n`, "---\ntitle: Other\n---\n- 2026-10-02 · from chat · B.\n")).toBe(`${front}- 2026-10-01 · from chat · A.\n- 2026-10-02 · from chat · B.\n`);
    expect(mergeMemoryText("- 2026-10-01 · from chat · A.\n", `${front}- 2026-10-02 · from chat · B.\n`)).toBe(`${front}- 2026-10-01 · from chat · A.\n- 2026-10-02 · from chat · B.\n`);
  });

  it("names the same pieces the same on both sides, which is what a move's check compares", () => {
    const here = memoryLines(mine);
    const there = new Set(memoryLines(mergeMemoryText(theirs, mine)));
    expect(here.every((line) => there.has(line))).toBe(true);
    expect(memoryLines(theirs).some((line) => !new Set(here).has(line))).toBe(true);
    expect(new Set(memoryLines("- 09:10 · from chat · Sent the invoice.\n- 09:10 · from chat · Sent the invoice.\n")).size).toBe(1);
  });
});

describe("what bots learned about the person", () => {
  const fact = (text: string) => ({ id: randomUUID(), text, line: `- 2026-10-03 · learned by Nova · ${text}`, botId: "b1", botName: "Nova", at: 1 });
  it("goes into About me once, never a fact the person removed on either side, and the removals are kept", () => {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(join(DATA_DIR, "profile-learned.json"), JSON.stringify({ learned: [], removed: ["Hates spam"] }));
    const pune = fact("Lives in Pune"), spam = fact("Hates spam"), tea = fact("Drinks tea");
    const adopted = adoptLearned([pune, spam, tea], ["Drinks tea"], "Runs a shop.\n- 2026-09-01 · learned by Kai · Lives in Pune");
    expect(adopted).toEqual({ aboutMe: "Runs a shop.\n- 2026-09-01 · learned by Kai · Lives in Pune", added: 0 });
    expect(learnedState()).toEqual({ learned: [pune], removed: ["Hates spam", "Drinks tea"] });
    const again = adoptLearned([fact("Has two dogs")], [], "Runs a shop.");
    expect(again).toEqual({ aboutMe: "Runs a shop.\n- 2026-10-03 · learned by Nova · Has two dogs", added: 1 });
    expect(adoptLearned([fact("x".repeat(300))], [], "y".repeat(23_900)), "no room in About me").toBeNull();
  });
});

describe("a team's memory and a bot's journal", () => {
  it("team entries arrive once: one this team has by id or by key stays as it is", () => {
    const memory = new TeamMemory(join(mkdtempSync(join(tmpdir(), "omb-team-")), "team-memory.json"));
    const entry = (id: string, name: string) => ({ id, kind: "person", name, detail: `${name} at Acme.`, aliases: [], status: "accepted", source: { botId: "b1", botName: "Nova", threadId: "t", at: 1 }, updatedAt: 1 });
    expect(memory.adopt("", [entry("e1", "Dana"), entry("e2", "Raj"), { id: "bad" }])).toBe(2);
    expect(memory.adopt("", [entry("e1", "Dana"), entry("e3", "dana"), entry("e4", "Lee")])).toBe(1);
    expect(memory.list("").map((held) => held.name).sort()).toEqual(["Dana", "Lee", "Raj"]);
  });

  it("journal rows arrive by id, in time order among this server's own, and none of them can be reverted here", async () => {
    const own = recordMemoryChange("b9", { path: "MEMORY.md", actor: "person", via: "ui", before: "a\n", after: "b\n" })!;
    await flushMemoryJournal("b9");
    const older: MemoryJournalEntry = { ...own, id: randomUUID(), at: own.at - 10_000, before: "secret before", canRevert: true };
    expect(await adoptMemoryJournal("b9", [older, { ...own }])).toBe(1);
    expect(await adoptMemoryJournal("b9", [older])).toBe(0);
    const rows = readFileSync(journalFile("b9"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as MemoryJournalEntry);
    expect(rows.map((row) => row.id)).toEqual([older.id, own.id]);
    expect(rows[0]).toMatchObject({ before: null, canRevert: false });
    expect(readMemoryJournal("b9", 10).map((row) => row.id)).toEqual([own.id, older.id]);
  });
});
