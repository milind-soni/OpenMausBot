// The entry grammar read back, the expiry rule, the narrow fact identity
// (the regressions #1362/#1363's review asked for), and the topic index.
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { factIdentity, isExpired, isMemoryDate, lineFactIdentity, notebookIdentities, parseMemoryEntries, withoutExpired } from "./memory-entries.ts";
import { parseTopicHeader, renderTopicIndex, TOPIC_INDEX_MAX_TOPICS } from "./memory-topics.ts";
import { closeMessageDb } from "./message-db.ts";
import { ensureWorkspace, loadMemory, memorySystemPrompt, searchMemoryFiles, updateMemory, writeMemoryFile, writeMemoryTopic, WORKSPACES_DIR } from "./workspace.ts";

const BOT = "bot-memory-entries";

describe("memory entry grammar", () => {
  it("parses dates, sources, until marks and strike-throughs", () => {
    const text = [
      "# Memory",
      "- 2026-09-10 · from chat \"Plans\" · Exams this weekend · until 2026-09-14",
      "- 2026-09-11 · ~~Office is in Pune~~ · superseded 2026-09-12",
      "- 2026-09-12 · Office is in Mumbai · updated 2026-09-13",
      "a hand-written line",
    ].join("\n");
    const entries = parseMemoryEntries(text);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ line: 1, date: "2026-09-10", body: "Exams this weekend", until: "2026-09-14", struck: false });
    expect(entries[1]).toMatchObject({ body: "Office is in Pune", struck: true, until: null });
    expect(entries[2]).toMatchObject({ body: "Office is in Mumbai", struck: false });
  });

  it("gives an entry the lines under it: indented ones and a code block it opens, never a fence that does not close", () => {
    const lines = [
      "- 2026-09-01 · Deploy command:", "  ```sh", "  railway up", "", "  ```", "  run it from the repo root",
      "- 2026-09-02 · Older shape:", "```sh", "railway up", "```",
      "- 2026-09-03 · Snippet ```", "x", "```",
      "- 2026-09-04 · Code blocks start with ```",
      "## Notes",
      "- 2026-09-05 · plain",
      "a hand-written line",
    ];
    expect(parseMemoryEntries(lines.join("\n")).map((e) => [e.line, e.end])).toEqual([[0, 6], [6, 10], [10, 13], [13, 14], [15, 16]]);
    // a block never runs over the next dated line: a fence it leaves open claims nothing
    const loose = ["- 2026-09-01 · Code blocks start with ```", "- 2026-09-02 · next", "- 2026-09-03 · Deploy:", "```sh", "railway up", "```"];
    expect(parseMemoryEntries(loose.join("\n")).map((e) => [e.line, e.end])).toEqual([[0, 1], [1, 2], [2, 6]]);
  });

  it("expires a live entry only after its until day, never a struck one", () => {
    expect(isExpired({ until: "2026-09-14", struck: false }, "2026-09-14")).toBe(false);
    expect(isExpired({ until: "2026-09-14", struck: false }, "2026-09-15")).toBe(true);
    expect(isExpired({ until: "2026-09-14", struck: true }, "2026-09-20")).toBe(false);
    expect(isExpired({ until: null, struck: false }, "2099-01-01")).toBe(false);
    const hidden = withoutExpired("- 2026-09-10 · Exams this weekend · until 2026-09-14\n- 2026-09-10 · Likes tea\n", "2026-09-15");
    expect(hidden).toEqual({ text: "- 2026-09-10 · Likes tea\n", hidden: 1 });
  });

  it("accepts only real calendar dates", () => {
    expect(isMemoryDate("2026-09-30")).toBe(true);
    expect(isMemoryDate("2026-02-30")).toBe(false);
    expect(isMemoryDate("next week")).toBe(false);
    expect(isMemoryDate(20260930)).toBe(false);
  });
});

describe("fact identity keeps meaning", () => {
  it.each([
    ["Balance is -10", "Balance is 10"],
    ["Uses C++", "Uses C"],
    ["Rate is 1.5", "Rate is 15"],
    ["Config at /tmp/a.json", "Config at /tmp/b.json"],
    ["Key name is API_KEY", "Key name is api_key"],
    ["Budget is $100", "Budget is 100"],
    ["Version >= 2", "Version 2"],
  ])("%s and %s are different facts", (a, b) => {
    expect(factIdentity(a)).not.toBe(factIdentity(b));
  });

  it("treats whitespace, a bullet and a final full stop as the same fact", () => {
    expect(factIdentity("-  Prefers   short replies.")).toBe(factIdentity("Prefers short replies"));
  });

  it("reads a notebook's live facts, ignoring struck ones and entry prefixes", () => {
    const notebook = "- 2026-09-10 · from chat \"A\" · Likes tea · until 2026-10-01\n- 2026-09-10 · ~~Lives in Pune~~ · superseded 2026-09-11\n";
    const ids = notebookIdentities(notebook);
    expect(ids.has("Likes tea")).toBe(true);
    expect(ids.has("Lives in Pune")).toBe(false);
    expect(lineFactIdentity("- 2026-09-10 · Balance is -10")).toBe("Balance is -10");
  });
});

describe("topic headers and the index", () => {
  it("reads title, description and aliases in both list styles", () => {
    expect(parseTopicHeader("---\ntitle: Clients\ndescription: \"Who we bill\"\naliases: [customers, accounts]\n---\nbody")).toEqual({
      title: "Clients",
      description: "Who we bill",
      aliases: ["customers", "accounts"],
    });
    expect(parseTopicHeader("---\naliases:\n  - food\n  - lunch\ntags: dining\n---\n").aliases).toEqual(["food", "lunch", "dining"]);
    expect(parseTopicHeader("no frontmatter here")).toEqual({ aliases: [] });
    // the panel's old new-topic text put a heading first
    expect(parseTopicHeader("# Dining\n\n---\naliases: [Bhel, Irani Cafe]\n---\n- Loves pasta\n")).toEqual({ title: "Dining", aliases: ["Bhel", "Irani Cafe"] });
    expect(parseTopicHeader("# Dining\n\n- Loves pasta\n")).toEqual({ title: "Dining", aliases: [] });
  });

  it("lists topics by name, the archive last, and caps the list", () => {
    const text = renderTopicIndex([
      { name: "archive.md", header: { aliases: [] } },
      { name: "dining.md", header: { title: "Dining", aliases: ["food"] } },
    ]);
    expect(text.split("\n")).toEqual([
      "- memory/dining.md — Dining (also: food)",
      "- memory/archive.md — older notes moved out of MEMORY.md, kept for the record",
    ]);
    // one label from code: an archive the old tidy-up wrote keeps a header that undersells it
    expect(renderTopicIndex([{ name: "archive.md", header: { title: "Archive", description: "expired notes moved out by the tidy-up", aliases: [] } }]))
      .toBe("- memory/archive.md — older notes moved out of MEMORY.md, kept for the record");
    const many = Array.from({ length: TOPIC_INDEX_MAX_TOPICS + 5 }, (_, i) => ({ name: `t${String(i).padStart(2, "0")}.md`, header: { aliases: [] } }));
    expect(renderTopicIndex(many)).toContain("…and 5 more in memory/");
  });
});

describe("memory with until dates and topics, on disk", () => {
  beforeEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    rmSync(WORKSPACES_DIR, { recursive: true, force: true });
  });

  it("appends an until mark, validates it, and hides the entry after that day", () => {
    const now = new Date(2026, 8, 10, 12);
    const ok = updateMemory(BOT, { action: "append", text: "Exams this weekend", until: "2026-09-14" }, { now, source: 'chat "Plans"' });
    expect(ok).toMatchObject({ ok: true, entry: '- 2026-09-10 · from chat "Plans" · Exams this weekend · until 2026-09-14' });
    expect(updateMemory(BOT, { action: "append", text: "x", until: "soon" }).ok).toBe(false);
    expect(updateMemory(BOT, { action: "remove", oldText: "Exams", until: "2026-09-14" }).ok).toBe(false);
    updateMemory(BOT, { action: "append", text: "Likes tea" }, { now });
    expect(loadMemory(BOT, { now: new Date(2026, 8, 14, 23) })?.text).toContain("Exams this weekend");
    const after = loadMemory(BOT, { now: new Date(2026, 8, 15, 1) });
    expect(after?.text).not.toContain("Exams this weekend");
    expect(after?.text).toContain("Likes tea");
    expect(after?.expired).toBe(1);
  });

  it("lists topic notes with their aliases in the prompt, and search finds a topic by alias", () => {
    ensureWorkspace(BOT);
    writeMemoryFile(BOT, "- 2026-09-10 · Likes tea\n");
    writeMemoryTopic(BOT, "dining.md", "---\ntitle: Dining\naliases: [food, lunch, restaurants]\n---\n- Loves pasta\n");
    writeFileSync(join(WORKSPACES_DIR, BOT, "memory", "notes.md"), "plain topic\n");
    const prompt = memorySystemPrompt(BOT, { managedWrites: true, fileTools: true });
    expect(prompt).toContain("Your topic notes (not loaded; when a request touches one of these topics, read that file with your file tools before you answer):");
    expect(prompt).toContain("- memory/dining.md — Dining (also: food, lunch, restaurants)");
    expect(prompt).toContain("- memory/notes.md");
    expect(memorySystemPrompt(BOT, { fileTools: false })).toContain("look it up with session_search before you answer");
    expect(searchMemoryFiles(BOT, "restaurants").map((hit) => hit.file)).toContain("memory/dining.md");
  });
});
