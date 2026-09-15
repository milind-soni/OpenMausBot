// Harness recall before a turn (Phase 1 part 2): gather what the bot's own
// notes, earlier conversations and captures say about the user's message,
// plus, on a fresh session, what the bot was doing recently — and render
// it as the recall block. No model call; every source is a lookup the
// harness already owns. A source that fails is empty, never an error.
import { digestPromptLine } from "./digest.ts";
import { recallMessages, recallTerms } from "./message-db.ts";
import { renderRecallBlock, type RecallBlock, type RecallPassage, type RecentItem } from "./recall-block.ts";
import type { Store } from "./store.ts";
import type { SupamausClient } from "./supamaus.ts";
import { listMemoryLogs, readMemoryLog, searchMemoryFiles } from "./workspace.ts";

/** What recall needs from the store, kept to a few reads. */
export type RecallStore = Pick<Store, "ownThreadIds" | "taskByThread" | "groupByThread" | "messagesFor" | "bot">;

export interface RecallInput {
  botId: string;
  botName: string;
  threadId: string;
  /** The search text, or null when the message is too short to search for. */
  query: string | null;
  /** Direct turns search the bot's other conversations; room turns do not
   * (recall from a private thread in a room stays the bot's own, disclosed
   * session_search). */
  includeConversations: boolean;
  /** A fresh session gets the "recently" section; a resumed one has it. */
  freshSession: boolean;
  captures?: SupamausClient;
  maxChars?: number;
  now?: () => number;
}

/** FTS5 brackets the matched terms in a snippet; the block reads better plain. */
const plain = (snippet: string) => snippet.replace(/\[([^[\]]+)\]/g, "$1");

/** How many distinct query terms a snippet matched (the bracketed ones). */
const matchedTerms = (snippet: string) => new Set([...snippet.matchAll(/\[([^[\]]+)\]/g)].map((m) => m[1]!.toLowerCase())).size;

/** A long question that shares only one word with a note is usually a
 * coincidence, a short one usually is not: from MIN_TERMS_FOR_TWO content
 * terms on (filler already dropped by recallTerms), a hit must match two.
 * Mirrors the capture rule in supamaus.ts. */
export const MIN_TERMS_FOR_TWO = 5;
function enoughMatches(query: string, snippet: string): boolean {
  return recallTerms(query).length < MIN_TERMS_FOR_TWO || matchedTerms(snippet) >= 2;
}

const MEMORY_HITS = 4;
const CONVERSATION_HITS = 4;
const CAPTURE_HITS = 3;
const RECENT_THREADS = 3;
const RECENT_CANDIDATES = 8;
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const RECENT_LOG_LINES = 3;
const RECENT_CAPTURE_MS = 60 * 60 * 1000;
const RECENT_TEXT_CHARS = 200;

function sourceLabel(store: RecallStore, botId: string, threadId: string): string {
  const room = store.groupByThread(threadId);
  if (room) return `room ${JSON.stringify(room.name)}`;
  const task = store.taskByThread(botId, threadId);
  return task ? `chat ${JSON.stringify(task.title)}` : "an earlier chat";
}

function memoryPassages(input: RecallInput): RecallPassage[] {
  if (!input.query) return [];
  try {
    return searchMemoryFiles(input.botId, input.query, MEMORY_HITS * 2, { mode: "any" }).filter((hit) => enoughMatches(input.query!, hit.snippet)).slice(0, MEMORY_HITS).map((hit) => ({
      source: "memory" as const,
      label: hit.file,
      at: hit.at,
      snippet: plain(hit.snippet),
      ref: { file: hit.file },
    }));
  } catch {
    return [];
  }
}

function conversationPassages(store: RecallStore, input: RecallInput, userName: string): RecallPassage[] {
  if (!input.query || !input.includeConversations) return [];
  try {
    const threads = store.ownThreadIds(input.botId).filter((id) => id !== input.threadId);
    return recallMessages(input.query, threads, CONVERSATION_HITS * 2, { mode: "any" }).filter((hit) => enoughMatches(input.query!, hit.snippet)).slice(0, CONVERSATION_HITS).map((hit) => ({
      source: "conversation" as const,
      label: sourceLabel(store, input.botId, hit.threadId),
      at: hit.at,
      snippet: hit.kind === "digest" ? `[what you did] ${plain(hit.snippet)}` : `${hit.role === "user" ? userName : hit.from ?? input.botName}: ${plain(hit.snippet)}`,
      ref: { threadId: hit.threadId, messageId: hit.messageId },
    }));
  } catch {
    return [];
  }
}

function capturePassages(input: RecallInput): RecallPassage[] {
  if (!input.query || !input.captures?.enabled()) return [];
  let hits: ReturnType<SupamausClient["searchNow"]> = [];
  try {
    input.captures.prime();
    hits = input.captures.searchNow(input.query, CAPTURE_HITS);
  } catch {
    hits = [];
  }
  return hits.map((hit) => ({
    source: "capture" as const,
    label: `capture ${JSON.stringify(hit.app || hit.title || "screen")}`,
    at: hit.at,
    snippet: `${hit.title && hit.title !== hit.app ? `${hit.title} — ` : ""}${hit.text || "(no text)"}`,
    ref: { captureId: hit.id },
  }));
}

const short = (text: string) => (text.length > RECENT_TEXT_CHARS ? `${text.slice(0, RECENT_TEXT_CHARS)}…` : text);

function recentItems(store: RecallStore, input: RecallInput): RecentItem[] {
  if (!input.freshSession) return [];
  const now = input.now?.() ?? Date.now();
  const items: RecentItem[] = [];
  try {
    const bot = store.bot(input.botId);
    const candidates = [...(bot?.tasks ?? [])]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((task) => task.threadId)
      .concat(bot ? [bot.threadId] : [])
      .filter((id) => id !== input.threadId)
      .slice(0, RECENT_CANDIDATES);
    const digests: Array<{ at: number; item: RecentItem }> = [];
    for (const threadId of candidates) {
      const messages = store.messagesFor(threadId);
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i]!;
        if (m.kind !== "digest" || !m.digest) continue;
        if (now - m.at <= RECENT_WINDOW_MS) digests.push({ at: m.at, item: { label: sourceLabel(store, input.botId, threadId), text: short(digestPromptLine(m.digest, input.botName)) } });
        break;
      }
    }
    digests.sort((a, b) => b.at - a.at);
    items.push(...digests.slice(0, RECENT_THREADS).map((d) => d.item));
  } catch {
    // no recent work to show
  }
  try {
    const logs = listMemoryLogs(input.botId).slice(-2);
    const lines: string[] = [];
    for (const name of logs) for (const line of (readMemoryLog(input.botId, name) ?? "").split("\n")) if (line.trim()) lines.push(line.trim());
    for (const line of lines.slice(-RECENT_LOG_LINES)) items.push({ label: "your log", text: short(line) });
  } catch {
    // logs are optional
  }
  if (input.captures?.enabled()) {
    try {
      input.captures.prime();
      for (const hit of input.captures.recentNow(RECENT_CAPTURE_MS)) items.push({ label: `capture ${JSON.stringify(hit.app || "screen")} (${hit.id})`, text: short(hit.text || hit.title || "(no text)") });
    } catch {
      // captures are optional
    }
  }
  return items;
}

/** The block for this turn, or null when there is nothing worth saying.
 * Synchronous on purpose: it runs on the turn path before dispatch, whose
 * ordering thread capacity and queued threads rely on; the only remote
 * source (SupaMaus) is read from its cache and refreshed in the background. */
export function buildRecall(store: RecallStore, input: RecallInput, userName = "User"): RecallBlock | null {
  const passages = [...memoryPassages(input), ...conversationPassages(store, input, userName), ...capturePassages(input)];
  return renderRecallBlock(passages, recentItems(store, input), input.maxChars ? { maxChars: input.maxChars } : {});
}
