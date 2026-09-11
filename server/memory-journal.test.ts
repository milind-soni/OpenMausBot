// The journal records every change to a memory file that the server can
// see, keeps the prior text so a revert needs nothing else, and never
// takes down the change it records. Bot writes are caught at the turn
// boundary; these tests simulate a bot's file tool with a plain write.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BEFORE_CAP,
  DIFF_CAP,
  JOURNAL_DIR,
  beginMemoryTurn,
  endMemoryTurn,
  flushMemoryJournal,
  journalFile,
  journalMemoryDelete,
  journalMemoryWrite,
  readMemoryJournal,
  recordMemoryChange,
  resetMemoryJournalState,
  revertMemoryChange,
  unifiedDiff,
} from "./memory-journal.ts";
import { MEMORY_INDEX, hashMemoryText, readMemoryDoc } from "./memory-store.ts";
import { WORKSPACES_DIR, ensureWorkspace, workspaceDir } from "./workspace.ts";

let counter = 0;
const freshBot = () => `journal-bot-${process.pid}-${counter++}`;

beforeEach(resetMemoryJournalState);
afterEach(resetMemoryJournalState);

describe("unifiedDiff", () => {
  it("is empty when nothing changed", () => {
    expect(unifiedDiff("a\nb\n", "a\nb\n", "MEMORY.md")).toEqual({ text: "", added: 0, removed: 0, truncated: false });
  });

  it("renders a hunk with two lines of context and counts lines", () => {
    const before = ["one", "two", "three", "four", "five", "six", "seven"].join("\n") + "\n";
    const after = ["one", "two", "three", "FOUR", "five", "six", "seven", "eight"].join("\n") + "\n";
    const diff = unifiedDiff(before, after, "memory/x.md");
    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(1);
    expect(diff.truncated).toBe(false);
    expect(diff.text.split("\n")).toEqual([
      "--- a/memory/x.md",
      "+++ b/memory/x.md",
      "@@ -2,6 +2,7 @@",
      " two",
      " three",
      "-four",
      "+FOUR",
      " five",
      " six",
      " seven",
      "+eight",
    ]);
  });

  it("splits far-apart changes into separate hunks", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `l${i}`);
    const changed = [...lines];
    changed[2] = "X";
    changed[25] = "Y";
    const diff = unifiedDiff(lines.join("\n"), changed.join("\n"), "MEMORY.md");
    expect(diff.text.match(/^@@/gm)).toHaveLength(2);
    expect(diff.text).toContain("@@ -1,5 +1,5 @@");
    expect(diff.text).toContain("@@ -24,5 +24,5 @@");
  });

  it("anchors a pure insertion into an empty file at line zero", () => {
    expect(unifiedDiff("", "new\n", "MEMORY.md").text).toContain("@@ -0,0 +1,1 @@\n+new");
    expect(unifiedDiff("gone\n", "", "MEMORY.md").text).toContain("@@ -1,1 +0,0 @@\n-gone");
  });

  it("caps the text and says so", () => {
    const before = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
    const diff = unifiedDiff(before, "", "MEMORY.md", 500);
    expect(diff.truncated).toBe(true);
    expect(diff.text.length).toBeLessThan(600);
    expect(diff.text.endsWith("… (diff cut here)")).toBe(true);
    expect(diff.removed).toBe(2000);
  });

  it("still counts correctly when the files are too big for an LCS table", () => {
    const a = Array.from({ length: 2500 }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: 2500 }, (_, i) => `b${i}`).join("\n");
    const diff = unifiedDiff(a, b, "MEMORY.md", DIFF_CAP);
    expect(diff.added).toBe(2500);
    expect(diff.removed).toBe(2500);
  });
});

describe("journalMemoryWrite / readMemoryJournal", () => {
  it("appends one 0600 row outside the workspace, newest first", async () => {
    const bot = freshBot();
    const first = journalMemoryWrite(bot, "memory/a.md", "one\n", { actor: "person", via: "ui" });
    expect(first.entry).toMatchObject({ path: "memory/a.md", kind: "created", actor: "person", via: "ui", beforeHash: null, before: null, added: 1, removed: 0, canRevert: true });
    expect(first.entry?.afterHash).toBe(hashMemoryText("one\n"));
    expect(first.doc.hash).toBe(hashMemoryText("one\n"));
    const second = journalMemoryWrite(bot, "memory/a.md", "one\ntwo\n", { actor: "person", via: "ui", threadId: "thread-1" });
    expect(second.entry).toMatchObject({ kind: "edited", before: "one\n", threadId: "thread-1", added: 1, removed: 0 });
    await flushMemoryJournal(bot);
    const rows = readMemoryJournal(bot, 10);
    expect(rows.map((r) => r.id)).toEqual([second.entry?.id, first.entry?.id]);
    expect(rows[0].diff).toContain("+two");
    const file = journalFile(bot);
    expect(file.startsWith(WORKSPACES_DIR)).toBe(false);
    expect(file.startsWith(JOURNAL_DIR)).toBe(true);
    // Windows has no POSIX mode bits: the write path sets them, the platform reports 0666.
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    // Windows has no POSIX mode bits: the write path sets them, the platform reports 0666.
    if (process.platform !== "win32") expect(statSync(JOURNAL_DIR).mode & 0o777).toBe(0o700);
  });

  it("records nothing when the text did not change", () => {
    const bot = freshBot();
    journalMemoryWrite(bot, "memory/same.md", "x", { actor: "person", via: "ui" });
    expect(journalMemoryWrite(bot, "memory/same.md", "x", { actor: "person", via: "ui" }).entry).toBeNull();
  });

  it("lets the store's refusals through untouched", () => {
    const bot = freshBot();
    const opened = journalMemoryWrite(bot, MEMORY_INDEX, "- a\n", { actor: "person", via: "ui" });
    writeFileSync(join(workspaceDir(bot), "MEMORY.md"), "- a\n- bot\n");
    expect(() => journalMemoryWrite(bot, MEMORY_INDEX, "- mine\n", { actor: "person", via: "ui", expectedHash: opened.doc.hash })).toThrow(/changed since/);
    expect(() => journalMemoryWrite(bot, "../x.md", "", { actor: "person", via: "ui" })).toThrow(/not a memory file/);
  });

  it("journals a delete with the prior text", async () => {
    const bot = freshBot();
    journalMemoryWrite(bot, "memory/gone.md", "bye\n", { actor: "person", via: "ui" });
    const entry = journalMemoryDelete(bot, "memory/gone.md", { actor: "person", via: "ui" });
    expect(entry).toMatchObject({ kind: "deleted", before: "bye\n", afterHash: null, removed: 1 });
    expect(journalMemoryDelete(bot, "memory/gone.md", { actor: "person", via: "ui" })).toBeNull();
  });

  it("caps what it keeps and refuses to promise a revert it cannot make", async () => {
    const bot = freshBot();
    const huge = "x".repeat(BEFORE_CAP + 1);
    const row = recordMemoryChange(bot, { path: "memory/huge.md", actor: "bot", via: "turn", before: huge, after: "small" });
    expect(row?.canRevert).toBe(false);
    expect(row?.before).toBeNull();
    expect(row?.revertUnavailableReason).toMatch(/too large/);
    const secret = recordMemoryChange(bot, {
      path: "memory/keys.md",
      actor: "bot",
      via: "turn",
      before: "token: sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH\n",
      after: "clean\n",
    });
    expect(secret?.canRevert).toBe(false);
    expect(secret?.before).not.toContain("AAAABBBB");
    expect(secret?.diff).not.toContain("AAAABBBB");
    await flushMemoryJournal(bot);
    expect(readFileSync(journalFile(bot), "utf8")).not.toContain("AAAABBBB");
    expect(revertMemoryChange(bot, secret!.id)).toMatchObject({ ok: false, status: 400 });
  });

  it("skips a torn last line rather than failing the read", async () => {
    const bot = freshBot();
    journalMemoryWrite(bot, "memory/a.md", "one", { actor: "person", via: "ui" });
    await flushMemoryJournal(bot);
    writeFileSync(journalFile(bot), '{"id":"torn","at":1,"pa', { flag: "a" });
    expect(readMemoryJournal(bot, 10)).toHaveLength(1);
  });

  it("never throws when the journal cannot be written", async () => {
    const bot = freshBot();
    // an append onto a directory fails on every platform
    mkdirSync(journalFile(bot), { recursive: true });
    expect(() => journalMemoryWrite(bot, "memory/a.md", "one", { actor: "person", via: "ui" })).not.toThrow();
    await expect(flushMemoryJournal(bot)).resolves.toBeUndefined();
    // the change itself still happened
    expect(readMemoryDoc(bot, "memory/a.md").text).toBe("one");
    expect(readMemoryJournal(bot, 10)).toEqual([]);
    rmSync(journalFile(bot), { recursive: true, force: true });
  });
});

describe("revertMemoryChange", () => {
  it("restores the earlier text atomically and journals the revert", async () => {
    const bot = freshBot();
    journalMemoryWrite(bot, "memory/y.md", "original\n", { actor: "person", via: "ui" });
    const edit = journalMemoryWrite(bot, "memory/y.md", "agent rewrote this\n", { actor: "bot", via: "turn", threadId: "t1" });
    await flushMemoryJournal(bot);
    const result = revertMemoryChange(bot, edit.entry!.id);
    expect(result.ok).toBe(true);
    expect(readMemoryDoc(bot, "memory/y.md").text).toBe("original\n");
    // Windows has no POSIX mode bits: the write path sets them, the platform reports 0666.
    if (process.platform !== "win32") expect(statSync(join(workspaceDir(bot), "memory", "y.md")).mode & 0o777).toBe(0o600);
    await flushMemoryJournal(bot);
    const [latest] = readMemoryJournal(bot, 1);
    expect(latest).toMatchObject({ actor: "person", via: "revert", before: "agent rewrote this\n", kind: "edited" });
    // and the revert can itself be reverted
    expect(revertMemoryChange(bot, latest.id).ok).toBe(true);
    expect(readMemoryDoc(bot, "memory/y.md").text).toBe("agent rewrote this\n");
  });

  it("reverts a creation by removing the file, and a deletion by restoring it", async () => {
    const bot = freshBot();
    const created = journalMemoryWrite(bot, "memory/new.md", "fresh\n", { actor: "bot", via: "turn" });
    await flushMemoryJournal(bot);
    expect(revertMemoryChange(bot, created.entry!.id).ok).toBe(true);
    expect(existsSync(join(workspaceDir(bot), "memory", "new.md"))).toBe(false);
    journalMemoryWrite(bot, "memory/keep.md", "keep me\n", { actor: "person", via: "ui" });
    const deleted = journalMemoryDelete(bot, "memory/keep.md", { actor: "bot", via: "turn" });
    await flushMemoryJournal(bot);
    expect(revertMemoryChange(bot, deleted!.id).ok).toBe(true);
    expect(readMemoryDoc(bot, "memory/keep.md").text).toBe("keep me\n");
  });

  it("empties MEMORY.md rather than deleting it when reverting its creation", async () => {
    const bot = freshBot();
    const row = recordMemoryChange(bot, { path: MEMORY_INDEX, actor: "bot", via: "turn", before: null, after: "hello" });
    ensureWorkspace(bot);
    await flushMemoryJournal(bot);
    expect(revertMemoryChange(bot, row!.id).ok).toBe(true);
    expect(existsSync(join(workspaceDir(bot), "MEMORY.md"))).toBe(true);
    expect(readMemoryDoc(bot, MEMORY_INDEX).text).toBe("");
  });

  it("answers 404 for an unknown row", () => {
    expect(revertMemoryChange(freshBot(), "nope")).toEqual({ ok: false, status: 404, error: "no such memory change" });
  });
});

describe("turn boundary", () => {
  it("journals what a turn wrote with its file tools, once, as the bot's", async () => {
    const bot = freshBot();
    ensureWorkspace(bot);
    writeFileSync(join(workspaceDir(bot), "memory", "existing.md"), "was here\n");
    beginMemoryTurn(bot, "thread-a");
    await flushMemoryJournal(bot);
    // first sighting is not a change
    expect(readMemoryJournal(bot, 10)).toEqual([]);

    // the bot's file tools at work
    writeFileSync(join(workspaceDir(bot), "MEMORY.md"), "- 2026-09-10 · from chat \"Follow-up\" · user prefers short replies\n");
    writeFileSync(join(workspaceDir(bot), "memory", "existing.md"), "was here\nand more\n");
    mkdirSync(join(workspaceDir(bot), "memory", "log"), { recursive: true });
    writeFileSync(join(workspaceDir(bot), "memory", "log", "2026-09-10.md"), "- did a thing\n");
    const rows = endMemoryTurn("thread-a");
    expect(rows.map((r) => [r.path, r.kind, r.actor, r.via, r.threadId])).toEqual([
      [MEMORY_INDEX, "edited", "bot", "turn", "thread-a"],
      ["memory/existing.md", "edited", "bot", "turn", "thread-a"],
      ["memory/log/2026-09-10.md", "created", "bot", "turn", "thread-a"],
    ]);
    // a second end for the same thread is a no-op, and the next turn sees nothing new
    expect(endMemoryTurn("thread-a")).toEqual([]);
    beginMemoryTurn(bot, "thread-b");
    expect(endMemoryTurn("thread-b")).toEqual([]);
    await flushMemoryJournal(bot);
    expect(readMemoryJournal(bot, 10)).toHaveLength(3);
  });

  it("attributes an edit made outside the app between turns to the person, via disk", async () => {
    const bot = freshBot();
    ensureWorkspace(bot);
    beginMemoryTurn(bot, "t1");
    endMemoryTurn("t1");
    writeFileSync(join(workspaceDir(bot), "MEMORY.md"), "edited in Obsidian\n");
    rmSync(join(workspaceDir(bot), "memory"), { recursive: true });
    mkdirSync(join(workspaceDir(bot), "memory"));
    beginMemoryTurn(bot, "t2");
    endMemoryTurn("t2");
    // the disk edit was journaled at begin, not at end
    await flushMemoryJournal(bot);
    expect(readMemoryJournal(bot, 10).map((r) => [r.path, r.actor, r.via])).toEqual([[MEMORY_INDEX, "person", "disk"]]);
  });

  it("does not re-journal a person's route write as the bot's when the turn ends", () => {
    const bot = freshBot();
    ensureWorkspace(bot);
    beginMemoryTurn(bot, "t1");
    journalMemoryWrite(bot, MEMORY_INDEX, "- person note\n", { actor: "person", via: "ui" });
    expect(endMemoryTurn("t1")).toEqual([]);
  });

  it("journals a file the turn deleted", () => {
    const bot = freshBot();
    ensureWorkspace(bot);
    writeFileSync(join(workspaceDir(bot), "memory", "doomed.md"), "x\n");
    beginMemoryTurn(bot, "t1");
    rmSync(join(workspaceDir(bot), "memory", "doomed.md"));
    const [row] = endMemoryTurn("t1");
    expect(row).toMatchObject({ path: "memory/doomed.md", kind: "deleted", before: "x\n", actor: "bot" });
  });

  it("diffs every member that spoke on a room thread", () => {
    const a = freshBot();
    const b = freshBot();
    ensureWorkspace(a);
    ensureWorkspace(b);
    beginMemoryTurn(a, "room-1");
    beginMemoryTurn(b, "room-1");
    writeFileSync(join(workspaceDir(a), "MEMORY.md"), "a learned\n");
    writeFileSync(join(workspaceDir(b), "MEMORY.md"), "b learned\n");
    const rows = endMemoryTurn("room-1");
    expect(rows.map((r) => r.botId).sort()).toEqual([a, b].sort());
  });

  it("never throws when a workspace vanished mid-turn", () => {
    const bot = freshBot();
    ensureWorkspace(bot);
    beginMemoryTurn(bot, "t1");
    rmSync(workspaceDir(bot), { recursive: true, force: true });
    expect(() => endMemoryTurn("t1")).not.toThrow();
    expect(() => beginMemoryTurn("bad/id", "t2")).not.toThrow();
  });
});
