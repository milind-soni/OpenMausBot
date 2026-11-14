import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { adoptMemoryJournal, journalFile, JOURNAL_DIR, type MemoryJournalEntry } from "./memory-journal.ts";

const bots: string[] = [];
const bot = () => { const id = `import-${randomUUID()}`; bots.push(id); return id; };
const entry = (id: string, at = 1): MemoryJournalEntry => ({
  id, at, botId: "source", path: "MEMORY.md", actor: "person", via: "ui", kind: "edited",
  beforeHash: "before", afterHash: "after", before: "source-only text", diff: "+note", added: 1, removed: 0, canRevert: true,
});
const rows = (id: string) => readFileSync(journalFile(id), "utf8").trim().split("\n").map((line) => JSON.parse(line) as MemoryJournalEntry);
afterEach(() => { for (const id of bots.splice(0)) rmSync(journalFile(id), { force: true }); });

describe("memory journal import by id", () => {
  it("adds an id only once within the incoming batch", async () => {
    const id = bot();
    const first = entry("same");
    expect(await adoptMemoryJournal(id, [first, { ...first, at: 2, diff: "different duplicate" }])).toBe(1);
    expect(rows(id)).toEqual([{ ...first, botId: id, before: null, canRevert: false, revertUnavailableReason: expect.any(String) }]);
    expect(first.before).toBe("source-only text");
    expect(first.canRevert).toBe(true);
  });

  it("does not duplicate a stored id older than the latest 500 rows", async () => {
    const id = bot();
    const held = Array.from({ length: 501 }, (_, index) => ({ ...entry(`held-${index}`, index), botId: id }));
    mkdirSync(JOURNAL_DIR, { recursive: true });
    const text = `${held.map((row) => JSON.stringify(row)).join("\n")}\n`;
    writeFileSync(journalFile(id), text);
    expect(await adoptMemoryJournal(id, [held[0]!])).toBe(0);
    expect(readFileSync(journalFile(id), "utf8")).toBe(text);
  });

  it("keeps existing content when a repeated id is mixed with a genuinely new row", async () => {
    const id = bot();
    await adoptMemoryJournal(id, [entry("later", 20)]);
    const earlier = entry("earlier", 10);
    expect(await adoptMemoryJournal(id, [entry("later", 99), earlier, earlier])).toBe(1);
    expect(rows(id).map((row) => [row.id, row.at])).toEqual([["earlier", 10], ["later", 20]]);
    expect(await adoptMemoryJournal(id, [earlier])).toBe(0);
  });

  it("retains malformed stored lines while deduplicating valid rows around them", async () => {
    const id = bot();
    mkdirSync(JOURNAL_DIR, { recursive: true });
    writeFileSync(journalFile(id), `not JSON\n${JSON.stringify(entry("held", 10))}\n`);
    expect(await adoptMemoryJournal(id, [entry("held"), entry("new", 20)])).toBe(1);
    const text = readFileSync(journalFile(id), "utf8");
    expect(text).toContain("not JSON\n");
    expect(text.match(/"id":"held"/g)).toHaveLength(1);
    expect(text.match(/"id":"new"/g)).toHaveLength(1);
  });
});
