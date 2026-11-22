import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { memoryOverview, parseMemoryPath, readMemoryDoc, threadNotesPath } from "./memory-store.ts";
import {
  THREAD_NOTES_MAX_LINES,
  createThreadScope,
  reachThreads,
  readThreadNotes,
  scopedMemoryUpdate,
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
    expect(prompt).toContain(JSON.stringify(join(workspaceDir(botId), "memory", "threads", "acme.md")));
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

describe("reaching another conversation on request", () => {
  const line = (id: string, role: string, text: string, at = 1) => ({ id, role, kind: "text", text, at });
  const history: Record<string, ReturnType<typeof line>[]> = {
    sm: [line("m1", "user", "Can we cap liability?"), line("m2", "bot", "Agreed: clause 7 caps it at fees paid."), line("m3", "user", "x".repeat(900))],
  };
  const reach = (botId: string, extra: Partial<Parameters<typeof reachThreads>[0]>) => reachThreads({
    botId, current: "here", threads: [{ threadId: "sm", title: "Supermouse lease", updatedAt: 5 }, { threadId: "here", title: "Acme NDA", updatedAt: 9 }],
    messages: (threadId) => history[threadId] ?? [], ...extra,
  });

  it("finds the same bot's other conversation by its name or its notes, never the one asking", () => {
    const botId = freshBot();
    updateThreadNotes(botId, "sm", { action: "append", text: "Agreed clause 7: liability capped at fees paid" });
    expect(reach(botId, { query: "supermouse" })).toEqual({ total: 1, threads: [{ threadId: "sm", title: "Supermouse lease", updatedAt: 5, notes: expect.stringContaining("liability capped") }] });
    expect(reach(botId, { query: "liability clause" })).toMatchObject({ total: 1 });
    expect(reach(botId, { query: "acme" })).toEqual({ total: 0, threads: [] });
    expect(reach(botId, {})).toMatchObject({ total: 1, threads: [{ threadId: "sm" }] });
  });

  it("reads one conversation's notes and its messages newest first, each cut short, with a cursor to older ones", () => {
    const botId = freshBot();
    updateThreadNotes(botId, "sm", { action: "append", text: "Clause 7 agreed" });
    const page = reach(botId, { threadId: "sm", limit: 2 });
    expect(page).toMatchObject({ thread: { threadId: "sm", title: "Supermouse lease" }, notes: expect.stringContaining("Clause 7 agreed"), earlier: "m2" });
    const messages = "messages" in page ? page.messages ?? [] : [];
    expect(messages.map((message) => [message.messageId, message.by, message.truncated])).toEqual([["m3", "person", true], ["m2", "bot", false]]);
    expect(messages[0]!.text).toHaveLength(500);
    expect(reach(botId, { threadId: "sm", before: "m2" })).toMatchObject({ messages: [{ messageId: "m1", by: "person" }], earlier: null });
  });

  it("answers not found for its own conversation, another bot's, and one it was not given", () => {
    const botId = freshBot();
    expect(reach(botId, { threadId: "here" })).toEqual({ error: "not-found" });
    expect(reach(botId, { threadId: "elsewhere" })).toEqual({ error: "not-found" });
    const other = freshBot();
    updateThreadNotes(botId, "sm", { action: "append", text: "Supermouse: liability capped" });
    expect(reach(other, { query: "liability" })).toEqual({ total: 0, threads: [] });
  });

  it("reads no notes while the bot's memory is off", () => {
    const botId = freshBot();
    updateThreadNotes(botId, "sm", { action: "append", text: "Clause 7 agreed" });
    expect(reach(botId, { threadId: "sm", notes: false })).toMatchObject({ notes: "" });
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
