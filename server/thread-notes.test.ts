import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { memoryOverview, parseMemoryPath, readMemoryDoc, threadNotesPath } from "./memory-store.ts";
import {
  THREAD_NOTES_MAX_LINES,
  createThreadScope,
  readThreadNotes,
  scopedMemoryUpdate,
  searchThreadNotes,
  threadNotesPrompt,
  updateThreadNotes,
} from "./thread-notes.ts";
import { ensureWorkspace, loadMemory, memoryNotesPrompt, readMemoryFile, searchMemoryFiles, workspaceDir } from "./workspace.ts";

let counter = 0;
const freshBot = () => {
  const id = `notes-bot-${process.pid}-${counter++}`;
  ensureWorkspace(id, "en");
  return id;
};
const noAboutMe = { source: "chat \"Acme\"", aboutMe: null };
const save = (botId: string, threadId: string | null, body: Record<string, unknown>) =>
  scopedMemoryUpdate(botId, body, noAboutMe, threadId ? { botId, threadId } : null);
const memoryText = (botId: string) => readMemoryFile(botId).text;

describe("which conversations keep their own notes", () => {
  const tasks = [
    { threadId: "main", createdAt: 1 },
    { threadId: "acme", createdAt: 2 },
    { threadId: "run", createdAt: 3, routineRunId: "r1" },
  ];
  const scope = (over: Partial<Parameters<typeof createThreadScope>[0]> = {}) => createThreadScope({
    tasks: () => tasks, chosen: () => undefined, room: () => false, routineRun: (id) => id === "run", team: false, ...over,
  });

  it("is every 1:1 conversation but the bot's main one", () => {
    const scoped = scope();
    expect(scoped("b", "main")).toBe(false);
    expect(scoped("b", "acme")).toBe(true);
  });

  it("follows the conversation the person set as main, and not the one they last wrote in", () => {
    expect(scope({ chosen: () => "acme" })("b", "main")).toBe(true);
    expect(scope({ chosen: () => "acme" })("b", "acme")).toBe(false);
    const archivedMain = [{ ...tasks[0], archivedAt: 5 }, tasks[1]!];
    expect(scope({ tasks: () => archivedMain })("b", "acme")).toBe(true);
  });

  it("leaves a one-chat bot, routine runs, rooms, unknown threads and a Team Cloud on the bot's memory", () => {
    expect(scope({ tasks: () => [tasks[0]!] })("b", "main")).toBe(false);
    expect(scope()("b", "run")).toBe(false);
    expect(scope({ room: (id) => id === "acme" })("b", "acme")).toBe(false);
    expect(scope()("b", "elsewhere")).toBe(false);
    expect(scope({ team: true })("b", "acme")).toBe(false);
  });
});

describe("memory_update in a conversation with its own notes", () => {
  it("keeps a matter's facts in that conversation's notes, out of MEMORY.md", () => {
    const botId = freshBot();
    const result = save(botId, "acme", { action: "append", text: "Acme's NDA runs two years" });
    expect(result).toMatchObject({ ok: true, scope: "thread" });
    expect(readThreadNotes(botId, "acme")).toContain("Acme's NDA runs two years");
    expect(memoryText(botId)).not.toContain("Acme");
  });

  it("saves to MEMORY.md in the main conversation, and with scope everywhere", () => {
    const botId = freshBot();
    expect(save(botId, null, { action: "append", text: "The person prefers short replies" })).not.toHaveProperty("scope");
    expect(save(botId, "acme", { action: "append", text: "The person works from Pune", scope: "everywhere" })).not.toHaveProperty("scope");
    expect(memoryText(botId)).toContain("short replies");
    expect(memoryText(botId)).toContain("works from Pune");
    expect(readThreadNotes(botId, "acme")).toBe("");
  });

  it("changes a passage where it is: this conversation's notes first, else MEMORY.md", () => {
    const botId = freshBot();
    save(botId, null, { action: "append", text: "The person prefers short replies" });
    save(botId, "acme", { action: "append", text: "Signing on Friday" });
    expect(save(botId, "acme", { action: "supersede", oldText: "Signing on Friday", text: "Signing on Monday" })).toMatchObject({ ok: true, scope: "thread" });
    expect(save(botId, "acme", { action: "replace", oldText: "short replies", text: "short, plain replies" })).toMatchObject({ ok: true });
    expect(readThreadNotes(botId, "acme")).toContain("~~Signing on Friday~~");
    expect(readThreadNotes(botId, "acme")).toContain("Signing on Monday");
    expect(memoryText(botId)).toContain("short, plain replies");
    expect(save(botId, "acme", { action: "remove", oldText: "short, plain replies", scope: "thread" })).toMatchObject({ ok: false, code: "conflict" });
  });

  it("forgets in this conversation's notes as well as everywhere else", () => {
    const botId = freshBot();
    save(botId, null, { action: "append", text: "Supermouse is a client" });
    save(botId, "acme", { action: "append", text: "Supermouse asked for a 30-day notice" });
    const forgot = save(botId, "acme", { action: "forget", oldText: "Supermouse" });
    expect(forgot).toMatchObject({ ok: true });
    expect(readThreadNotes(botId, "acme")).not.toContain("Supermouse");
    expect(memoryText(botId)).not.toContain("Supermouse");
  });

  it("never lists, indexes or recalls a conversation's notes with the bot's memory", () => {
    const botId = freshBot();
    updateThreadNotes(botId, "acme", { action: "append", text: "Zanzibarclause is the agreed indemnity" });
    expect(memoryOverview(botId).topics).toEqual([]);
    expect(searchMemoryFiles(botId, "Zanzibarclause")).toEqual([]);
    expect(loadMemory(botId)?.text ?? "").not.toContain("Zanzibarclause");
    expect(memoryNotesPrompt(botId, { managedWrites: true })).not.toContain("Zanzibarclause");
  });
});

describe("what each conversation's prompt holds", () => {
  it("loads thread A's notes in thread A only", () => {
    const botId = freshBot();
    updateThreadNotes(botId, "a", { action: "append", text: "Client A pays in euros" });
    updateThreadNotes(botId, "b", { action: "append", text: "Client B pays in yen" });
    const a = threadNotesPrompt(botId, "a", { scoped: true, managedWrites: true });
    const b = threadNotesPrompt(botId, "b", { scoped: true, managedWrites: true });
    expect(a).toContain("Client A pays in euros");
    expect(a).not.toContain("Client B");
    expect(b).toContain("Client B pays in yen");
    expect(b).not.toContain("Client A");
  });

  it("tells a scoped conversation how to choose, and leaves a main conversation's prompt as it was", () => {
    const botId = freshBot();
    expect(threadNotesPrompt(botId, "main", { scoped: false, managedWrites: true })).toBe("");
    const scoped = threadNotesPrompt(botId, "acme", { scoped: true, managedWrites: true });
    expect(scoped).toContain("scope \"everywhere\"");
    expect(scoped).toContain("never ask the person which");
    expect(scoped).toContain("(none yet)");
  });

  it("names the notes file to an engine that keeps memory with its own file tools", () => {
    const botId = freshBot();
    const prompt = threadNotesPrompt(botId, "acme", { scoped: true, managedWrites: false, fileTools: true });
    expect(prompt).toContain(join(workspaceDir(botId), "memory", "threads", "acme.md"));
  });

  it("shows nothing when memory is off, and notes without rules when writes are refused", () => {
    const botId = freshBot();
    updateThreadNotes(botId, "acme", { action: "append", text: "Deadline 1 December" });
    expect(threadNotesPrompt(botId, "acme", { scoped: true, enabled: false, managedWrites: true })).toBe("");
    const refused = threadNotesPrompt(botId, "acme", { scoped: true, writesRefused: true, managedWrites: true });
    expect(refused).toContain("Deadline 1 December");
    expect(refused).not.toContain("memory_update");
  });

  it("cuts long notes at the budget and says so", () => {
    const botId = freshBot();
    for (let line = 0; line < THREAD_NOTES_MAX_LINES + 5; line += 1) updateThreadNotes(botId, "long", { action: "append", text: `fact ${line}` });
    const prompt = threadNotesPrompt(botId, "long", { scoped: true, managedWrites: true });
    expect(prompt).toContain("fact 0");
    expect(prompt).not.toContain(`fact ${THREAD_NOTES_MAX_LINES + 4}`);
    expect(prompt).toContain(`Only the first ${THREAD_NOTES_MAX_LINES} lines`);
  });
});

describe("reading another conversation's notes on request", () => {
  it("finds the same bot's other conversation by its name or its notes", () => {
    const botId = freshBot();
    updateThreadNotes(botId, "sm", { action: "append", text: "Agreed clause 7: liability capped at fees paid" });
    const threads = [{ threadId: "sm", title: "Supermouse lease" }, { threadId: "here", title: "Acme NDA" }];
    expect(searchThreadNotes(botId, threads, "supermouse", { current: "here" })).toEqual([
      { threadId: "sm", title: "Supermouse lease", text: expect.stringContaining("liability capped") },
    ]);
    expect(searchThreadNotes(botId, threads, "liability clause", { current: "here" })).toHaveLength(1);
    expect(searchThreadNotes(botId, threads, "supermouse", { current: "sm" })).toEqual([]);
  });

  it("never reads another bot's conversations", () => {
    const owner = freshBot();
    const other = freshBot();
    updateThreadNotes(owner, "sm", { action: "append", text: "Supermouse: liability capped" });
    expect(searchThreadNotes(other, [{ threadId: "sm", title: "Supermouse lease" }], "supermouse")).toEqual([]);
  });
});

describe("the notes file", () => {
  it("is one allowlisted path per conversation, written owner-only and redacted", () => {
    const botId = freshBot();
    expect(parseMemoryPath(threadNotesPath("t-1")).kind).toBe("thread");
    expect(() => parseMemoryPath("memory/threads/../MEMORY.md")).toThrow();
    expect(() => parseMemoryPath("memory/threads/a/b.md")).toThrow();
    updateThreadNotes(botId, "t-1", { action: "append", text: "token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" });
    const file = join(workspaceDir(botId), "memory", "threads", "t-1.md");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(readMemoryDoc(botId, threadNotesPath("t-1")).exists).toBe(true);
  });
});
