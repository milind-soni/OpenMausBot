// A conversation's own notes: the facts of the matter it is about (a client, the parties, terms, deadlines), kept in
// memory/threads/<thread>.md beside the bot's memory and loaded into that conversation only. The bot's MEMORY.md and
// topics keep what holds in every conversation. The bot picks the scope of each save; the person is never asked.
//
// Security: thread notes never reach the bot-wide memory by themselves. They are not listed with the topics, not
// indexed for recall or session_search, not journaled, not archived and not read by memory upkeep; another of the
// bot's conversations reads them only through session_search scope "threads", on that bot's own conversations.
import { chatNotice, type ChatNoticeKey } from "./chat-notices.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { memoryHomeThread } from "./main-thread.ts";
import { passageMatcher, withoutExpired } from "./memory-entries.ts";
import { botMemoryUpdate, withoutMentions, type BotMemoryResult } from "./memory-forget.ts";
import { clearForgotten } from "./profile-learned.ts";
import { MemoryStoreError, readMemoryDoc, threadNotesPath, writeMemoryDoc } from "./memory-store.ts";
import { editMemoryText, memoryDate, workspaceDir, type MemoryUpdate, type MemoryUpdateOptions, type MemoryUpdateResult } from "./workspace.ts";
import { join } from "node:path";

export const THREAD_NOTES_MAX_LINES = 100;
export const THREAD_NOTES_MAX_BYTES = 12_000;

export type MemoryScopeChoice = "thread" | "everywhere";

interface ScopeTask {
  threadId: string;
  createdAt: number;
  archivedAt?: number;
  routineRunId?: string;
}

export interface ThreadScopeDeps {
  /** The bot's conversations the main-thread choice may name. */
  tasks(botId: string): readonly ScopeTask[];
  /** The conversation the person set as main ("Set as main thread"), if any. */
  chosen(botId: string): string | undefined;
  room(threadId: string): boolean;
  routineRun(threadId: string): boolean;
  /** A Team Cloud keeps each person's notes in their own layer of the bot's memory instead. */
  team: boolean;
}

/** Whether saves in this conversation default to its own notes: a 1:1 conversation of the bot other than its main one.
 * A routine run starts a fresh conversation each time, so its notes would never be read again: it keeps the bot's
 * memory, as do rooms, the main conversation and every conversation on a Team Cloud. */
export function createThreadScope(deps: ThreadScopeDeps): (botId: string, threadId: string) => boolean {
  return (botId, threadId) => {
    if (deps.team || deps.room(threadId) || deps.routineRun(threadId)) return false;
    const tasks = deps.tasks(botId);
    const task = tasks.find((candidate) => candidate.threadId === threadId);
    if (!task || task.routineRunId) return false;
    return memoryHomeThread(tasks, deps.chosen(botId)) !== threadId;
  };
}

export function readThreadNotes(botId: string, threadId: string): string {
  try {
    return readMemoryDoc(botId, threadNotesPath(threadId)).text;
  } catch (error) {
    if (error instanceof MemoryStoreError) return "";
    throw error;
  }
}

export function threadNotesOverBudget(text: string): boolean {
  return (text ? text.split("\n").length : 0) > THREAD_NOTES_MAX_LINES || Buffer.byteLength(text, "utf8") > THREAD_NOTES_MAX_BYTES;
}

/** What loads of a conversation's notes: expired entries hidden, then cut at the budget. */
export function loadedThreadNotes(raw: string, now?: Date): { text: string; truncated: boolean } {
  let text = withoutExpired(raw, memoryDate(now)).text.trim();
  let truncated = false;
  if (text.split("\n").length > THREAD_NOTES_MAX_LINES) {
    text = text.split("\n").slice(0, THREAD_NOTES_MAX_LINES).join("\n");
    truncated = true;
  }
  if (Buffer.byteLength(text, "utf8") > THREAD_NOTES_MAX_BYTES) {
    text = Buffer.from(text, "utf8").subarray(0, THREAD_NOTES_MAX_BYTES).toString("utf8").replace(/�+$/, "");
    truncated = true;
  }
  return { text, truncated };
}

export type ThreadNotesResult = (MemoryUpdateResult & { ok: true; scope: "thread" }) | Extract<MemoryUpdateResult, { ok: false }>;

/** One memory_update applied to this conversation's notes. Nothing moves out when they fill: the tool says they are full. */
export function updateThreadNotes(botId: string, threadId: string, update: MemoryUpdate, opts: MemoryUpdateOptions = {}): ThreadNotesResult {
  const path = threadNotesPath(threadId);
  const current = readMemoryDoc(botId, path).text;
  const edit = editMemoryText(current, update, opts);
  if (!edit.ok) {
    return edit.code === "conflict" && update.action !== "supersede"
      ? { ...edit, error: "old_text must match exactly once in this conversation's notes. Re-read them and retry with a current, unique passage." }
      : edit;
  }
  const written = writeMemoryDoc(botId, path, edit.next);
  return { ok: true, scope: "thread", truncated: threadNotesOverBudget(written.after), ...(edit.entry !== undefined ? { entry: edit.entry } : {}), moved: [] };
}

/** "Forget X" in this conversation's notes too; the facts removed. */
export function forgetInThreadNotes(botId: string, threadId: string, mentions: (text: string) => boolean): string[] {
  const current = readThreadNotes(botId, threadId);
  if (!current) return [];
  const kept = withoutMentions(current, mentions);
  if (kept.removed.length) writeMemoryDoc(botId, threadNotesPath(threadId), kept.text);
  return kept.removed;
}

type MemoryBody = { action?: unknown; text?: unknown; oldText?: unknown; until?: unknown; scope?: unknown };

/** memory_update from a bot's turn, in `thread` when its saves default to that conversation's notes. "everywhere" and a
 * preference go to the bot's memory as before; forget reaches this conversation's notes as well as everything else. A
 * change to a passage that is only in MEMORY.md, with no scope given, changes it there. */
export function scopedMemoryUpdate(
  layer: string,
  body: MemoryBody,
  opts: Parameters<typeof botMemoryUpdate>[2],
  thread: { botId: string; threadId: string } | null,
): BotMemoryResult | ThreadNotesResult {
  if (!thread || body.scope === "everywhere" || body.action === "prefer") return botMemoryUpdate(layer, body, opts);
  if (body.action === "forget") {
    const result = botMemoryUpdate(layer, body, opts);
    const mentions = typeof body.oldText === "string" ? passageMatcher(body.oldText) : null;
    if (!result.ok || !("forgotten" in result) || !mentions) return result;
    return { ...result, forgotten: [...forgetInThreadNotes(thread.botId, thread.threadId, mentions), ...result.forgotten] };
  }
  const passage = typeof body.oldText === "string" ? body.oldText : undefined;
  if (body.scope !== "thread" && passage?.trim() && !readThreadNotes(thread.botId, thread.threadId).includes(passage)) return botMemoryUpdate(layer, body, opts);
  const update = { action: body.action, text: body.text, oldText: body.oldText, ...(body.until !== undefined ? { until: body.until } : {}) } as MemoryUpdate;
  const result = updateThreadNotes(thread.botId, thread.threadId, update, { source: opts.source });
  if ((body.action === "append" || body.action === "supersede") && result.ok && typeof body.text === "string") clearForgotten(body.text);
  return result;
}

const SCOPE_RULES =
  " This is one of several conversations you keep with the person, and it has its own notes, loaded here and in no other conversation." +
  " memory_update takes scope. For the matter this conversation is about (the client, the parties, terms, deadlines, what was decided), leave scope out or pass \"thread\": it goes to this conversation's notes." +
  " Pass scope \"everywhere\" for what holds in every conversation: facts about the person, how they like to work, their standing preferences, or anything they ask you to remember everywhere or for all their clients; it goes to MEMORY.md." +
  " Choose the scope yourself; never ask the person which." +
  " Only when the person refers to another of your conversations (\"the clause we agreed for Supermouse\"), find it with session_search scope \"threads\" and words naming it, then read it with its thread_id, for that request only.";

/** This conversation's notes and, in a conversation whose saves default to them, how to save there. For the volatile half
 * of the prompt, beside MEMORY.md, so a main conversation's prompt is unchanged and a compaction never drops them. */
export function threadNotesPrompt(
  botId: string,
  threadId: string,
  opts: { scoped: boolean; enabled?: boolean; managedWrites?: boolean; fileTools?: boolean; writesRefused?: boolean },
): string {
  if (opts.enabled === false) return "";
  const notes = loadedThreadNotes(readThreadNotes(botId, threadId));
  const canWrite = opts.scoped && !opts.writesRefused && (opts.managedWrites || opts.fileTools !== false);
  if (!notes.text && !canWrite) return "";
  const rules = !canWrite ? "" : opts.managedWrites
    ? SCOPE_RULES
    : ` This is one of several conversations you keep with the person. Keep facts about the matter it is about (the client, the parties, terms, deadlines, what was decided) in ${JSON.stringify(join(workspaceDir(botId), threadNotesPath(threadId)))} with your file tools, as dated bullet lines; that file loads here and in no other conversation. Facts about the person and how they like to work still go to MEMORY.md. Choose yourself; never ask the person which.`;
  const cut = notes.truncated ? ` [Only the first ${THREAD_NOTES_MAX_LINES} lines / ${THREAD_NOTES_MAX_BYTES} bytes are shown.]` : "";
  return `${rules}\n\nThis conversation's notes:\n${notes.text || "(none yet)"}${cut}`;
}

/** One of the bot's own conversations another may reach, as the caller found it allowed. */
export interface ReachableThread {
  threadId: string;
  title?: string;
  updatedAt?: number;
  createdAt?: number;
}

interface ThreadLine {
  id?: string;
  role: string;
  kind: string;
  text?: string;
  at?: number;
}

export const THREAD_LIST_LIMIT = 10;
export const THREAD_LIST_MAX = 25;
export const THREAD_READ_LIMIT = 10;
export const THREAD_LINE_CHARS = 500;
export const THREAD_READ_BUDGET = 8_000;
const NOTES_PREVIEW_CHARS = 300;

const cut = (text: string, max: number) => {
  if (text.length <= max) return { text, truncated: false };
  const end = /[\uD800-\uDBFF]/.test(text[max - 1] ?? "") ? max - 1 : max;
  return { text: text.slice(0, end), truncated: true };
};

/** session_search scope "threads": the bot's other conversations, never another bot's. With `threadId`, that
 * conversation's notes and a page of its messages, newest first, each cut short, before the message `before` names;
 * with `query`, the conversations whose title or notes hold every word; with neither, the newest. An id that is not one
 * of `threads` reads as not found, so the answer never says whether another bot's conversation exists. */
export function reachThreads(input: {
  botId: string;
  current: string;
  threads: readonly ReachableThread[];
  messages(threadId: string): readonly ThreadLine[];
  query?: string;
  threadId?: string;
  before?: string;
  limit?: number;
  /** False while the bot's memory is off: its conversations are still read, their notes are not. */
  notes?: boolean;
}) {
  const notesOf = (threadId: string) => input.notes === false ? { text: "", truncated: false } : loadedThreadNotes(readThreadNotes(input.botId, threadId));
  const others = input.threads.filter((thread) => thread.threadId !== input.current);
  if (input.threadId) {
    const thread = others.find((candidate) => candidate.threadId === input.threadId);
    if (!thread) return { error: "not-found" as const };
    const notes = notesOf(thread.threadId);
    const lines = input.messages(thread.threadId).filter((line) => (line.role === "user" || line.role === "bot") && line.kind === "text" && line.text?.trim());
    const end = input.before ? lines.findIndex((line) => line.id === input.before) : lines.length;
    const limit = Math.min(Math.max(1, input.limit ?? THREAD_READ_LIMIT), THREAD_LIST_MAX);
    const first = (end === -1 ? 0 : end) - 1;
    const reserved = Math.min(THREAD_LINE_CHARS, lines[first]?.text?.trim().length ?? 0);
    const shownNotes = cut(notes.text, THREAD_READ_BUDGET - reserved);
    let budget = THREAD_READ_BUDGET - shownNotes.text.length;
    const page: Array<{ messageId?: string; by: "person" | "bot"; at?: number; text: string; truncated: boolean }> = [];
    for (let index = first; index >= 0 && page.length < limit && budget > 0; index -= 1) {
      const line = lines[index]!;
      const shown = cut(line.text!.trim(), Math.min(THREAD_LINE_CHARS, budget));
      if (!shown.text) break;
      budget -= shown.text.length;
      page.push({ ...(line.id ? { messageId: line.id } : {}), by: line.role === "user" ? "person" : "bot", ...(line.at ? { at: line.at } : {}), ...shown });
    }
    const oldest = (end === -1 ? 0 : end) - page.length;
    return {
      thread: { threadId: thread.threadId, ...(thread.title ? { title: thread.title } : {}) },
      notes: shownNotes.text, notesTruncated: notes.truncated || shownNotes.truncated,
      messages: page,
      earlier: oldest > 0 ? page.at(-1)?.messageId ?? null : null,
    };
  }
  const words = (input.query ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0);
  const found = others.flatMap((thread) => {
    const notes = notesOf(thread.threadId).text;
    const title = (thread.title ?? "").toLowerCase();
    const haystack = `${title}\n${notes.toLowerCase()}`;
    if (!words.every((word) => haystack.includes(word))) return [];
    return [{ thread, notes, titled: words.filter((word) => title.includes(word)).length }];
  }).sort((a, b) => b.titled - a.titled || (b.thread.updatedAt ?? b.thread.createdAt ?? 0) - (a.thread.updatedAt ?? a.thread.createdAt ?? 0));
  const limit = Math.min(Math.max(1, input.limit ?? THREAD_LIST_LIMIT), THREAD_LIST_MAX);
  return {
    total: found.length,
    threads: found.slice(0, limit).map(({ thread, notes }) => ({
      threadId: thread.threadId,
      ...(thread.title ? { title: thread.title } : {}),
      ...(thread.updatedAt ?? thread.createdAt ? { updatedAt: thread.updatedAt ?? thread.createdAt } : {}),
      notes: cut(notes, NOTES_PREVIEW_CHARS).text,
    })),
  };
}

/** "Saved to this thread", once, under the reply of a turn that saved to its conversation's notes. */
export function createThreadSaveLines(deps: {
  bus: { subscribe(listener: (event: RuntimeEvent) => void): unknown };
  append(threadId: string, tool: { name: string; nameCode: ChatNoticeKey; ok: true }): void;
}): { saved(threadId: string): void } {
  const saved = new Set<string>();
  deps.bus.subscribe((event) => {
    if (event.type !== "turn.completed" || !saved.delete(event.threadId)) return;
    deps.append(event.threadId, { name: `notice: ${chatNotice("chat.notice.savedToThread")}`, nameCode: "chat.notice.savedToThread", ok: true });
  });
  return { saved: (threadId) => void saved.add(threadId) };
}
