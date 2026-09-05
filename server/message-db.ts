// SQLite persistence for thread transcripts.
//
// messages-<threadId>.json rewrote the WHOLE thread file on every append —
// a long computer-use thread reaches megabytes, so each new message cost
// more disk than the last. This store writes deltas instead: one INSERT
// per message, one UPDATE per patch, and reads a thread once into the
// Store's in-memory cache. node:sqlite (built into Node ≥23.4) keeps it
// dependency-free — nothing new to bundle for the packaged app.
//
// Legacy JSON thread files import lazily: the first read of a thread with
// no rows pulls the old file in, after which the DB is the source of
// truth (the JSON file is left behind as a one-time backup).
import { chmodSync, closeSync, existsSync, openSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DATA_DIR } from "./config.ts";
import { peerProvenanceAuthor } from "./peer-provenance.ts";
import type { Message } from "./store.ts";

const DB_FILE = () => join(DATA_DIR, "messages.db");

let handle: DatabaseSync | null = null;
let handlePath: string | null = null;

function open(): DatabaseSync {
  const file = DB_FILE();
  // Transcripts can contain private conversations and tool output. Create
  // the database with owner-only permissions and also repair an existing
  // file that may have inherited a permissive umask.
  closeSync(openSync(file, "a", 0o600));
  try {
    chmodSync(file, 0o600);
  } catch {}
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      thread_id TEXT NOT NULL,
      id TEXT NOT NULL,
      at INTEGER NOT NULL,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT,
      json TEXT NOT NULL,
      PRIMARY KEY (thread_id, id)
    );
    CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id);
    CREATE TABLE IF NOT EXISTS thread_state (
      thread_id TEXT PRIMARY KEY,
      active_leaf_id TEXT
    );
  `);
  ensureRecallIndex(db);
  return db;
}

// Ranked recall over transcript text, for the bot's own session_search tool.
// An external-content FTS5 table over messages.text: the index stores no
// copy of the text, and three triggers keep it in step with every insert,
// update, and delete on `messages`. FTS5 ships inside node:sqlite, so this
// is no more of a dependency than the table it indexes. The sidebar's LIKE
// search below stays as it is — substring find over a single thread wants
// every occurrence, not a relevance ranking.
function ensureRecallIndex(db: DatabaseSync): void {
  const existed = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'")
    .get();
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      text, content='messages', content_rowid='rowid', tokenize='unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
      INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
  `);
  // First time on an existing database: index everything already there.
  if (!existed) db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");
}

// INSERT OR REPLACE would delete and re-insert the row under a new rowid
// without firing the delete trigger (SQLite only fires it with recursive
// triggers on), leaving a dangling FTS entry. An upsert keeps the rowid and
// runs the update trigger, so the index never drifts from the table.
const UPSERT_MESSAGE =
  "INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?) " +
  "ON CONFLICT(thread_id, id) DO UPDATE SET at = excluded.at, role = excluded.role, kind = excluded.kind, " +
  "text = excluded.text, json = excluded.json";

/** The live handle — reopened when the file was removed out from under us
 * (tests wipe DATA_DIR between cases; a fresh Store must get a fresh DB,
 * not a handle onto an unlinked inode). */
function db(): DatabaseSync {
  if (handle && handlePath === DB_FILE() && existsSync(DB_FILE())) return handle;
  try {
    handle?.close();
  } catch {}
  handle = open();
  handlePath = DB_FILE();
  return handle;
}

const rowToMessage = (row: { json: string }): Message => JSON.parse(row.json) as Message;

export interface ThreadRows {
  messages: Message[];
  activeLeafId: string | null;
}

/** Read one thread, importing its legacy JSON file on first touch. */
export function readThread(threadId: string, legacyFile: string): ThreadRows {
  const rows = db()
    .prepare("SELECT json FROM messages WHERE thread_id = ? ORDER BY rowid")
    .all(threadId) as Array<{ json: string }>;
  if (rows.length) {
    const state = db()
      .prepare("SELECT active_leaf_id FROM thread_state WHERE thread_id = ?")
      .get(threadId) as { active_leaf_id: string | null } | undefined;
    return { messages: rows.map(rowToMessage), activeLeafId: state?.active_leaf_id ?? null };
  }
  return importLegacy(threadId, legacyFile);
}

function importLegacy(threadId: string, legacyFile: string): ThreadRows {
  let messages: Message[] = [];
  let activeLeafId: string | null = null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(legacyFile, "utf8"));
  } catch {
    return { messages, activeLeafId }; // fresh thread
  }
  if (Array.isArray(raw)) messages = raw as Message[]; // pre-branching flat file
  else if (raw && typeof raw === "object") {
    messages = ((raw as { messages?: Message[] }).messages ?? []) as Message[];
    activeLeafId = (raw as { activeLeafId?: string | null }).activeLeafId ?? null;
  }
  const insert = db().prepare(UPSERT_MESSAGE);
  db().exec("BEGIN");
  try {
    for (const message of messages) {
      insert.run(threadId, message.id, message.at, message.role, message.kind, message.text ?? null, JSON.stringify(message));
    }
    setActiveLeaf(threadId, activeLeafId);
    db().exec("COMMIT");
  } catch (error) {
    db().exec("ROLLBACK");
    throw error;
  }
  // left beside the DB as a one-time backup, renamed so the import never
  // runs twice against a thread whose rows were later deleted
  try {
    renameSync(legacyFile, `${legacyFile}.imported`);
    try {
      chmodSync(`${legacyFile}.imported`, 0o600);
    } catch {}
  } catch {}
  return { messages, activeLeafId };
}

export function insertMessage(threadId: string, message: Message): void {
  db()
    .prepare(UPSERT_MESSAGE)
    .run(threadId, message.id, message.at, message.role, message.kind, message.text ?? null, JSON.stringify(message));
}

/** A backup may only populate a fresh thread, never replace a transcript. */
export function importThread(threadId: string, messages: Message[], activeLeafId: string | null): void {
  const database = db();
  database.exec("BEGIN IMMEDIATE");
  try {
    if (database.prepare("SELECT 1 FROM messages WHERE thread_id = ? LIMIT 1").get(threadId) ||
        database.prepare("SELECT 1 FROM thread_state WHERE thread_id = ?").get(threadId)) {
      throw new Error("Cannot import over an existing conversation");
    }
    for (const message of messages) insertMessage(threadId, message);
    setActiveLeaf(threadId, activeLeafId);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

/** Persist a new message and the branch head as one crash-safe mutation. */
export function appendMessage(threadId: string, message: Message): void {
  const database = db();
  database.exec("BEGIN IMMEDIATE");
  try {
    insertMessage(threadId, message);
    setActiveLeaf(threadId, message.id);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function updateMessage(threadId: string, message: Message): void {
  db()
    .prepare("UPDATE messages SET at = ?, role = ?, kind = ?, text = ?, json = ? WHERE thread_id = ? AND id = ?")
    .run(message.at, message.role, message.kind, message.text ?? null, JSON.stringify(message), threadId, message.id);
}

/** Goal cards are new SQLite-backed messages, so crash recovery can locate
 * the tiny set of unfinished receipts without eagerly loading every room
 * transcript into memory at startup. */
export function workingGoalRunMessages(): Array<{ threadId: string; message: Message }> {
  const rows = db()
    .prepare(
      "SELECT thread_id, json FROM messages " +
      "WHERE kind = 'goal.run' AND json_extract(json, '$.goalRun.status') = 'working'",
    )
    .all() as Array<{ thread_id: string; json: string }>;
  return rows.map((row) => ({ threadId: row.thread_id, message: JSON.parse(row.json) as Message }));
}

export function setActiveLeaf(threadId: string, leafId: string | null): void {
  db()
    .prepare(
      "INSERT INTO thread_state (thread_id, active_leaf_id) VALUES (?, ?) " +
        "ON CONFLICT(thread_id) DO UPDATE SET active_leaf_id = excluded.active_leaf_id",
    )
    .run(threadId, leafId);
}

export function deleteThread(threadId: string): void {
  db().prepare("DELETE FROM messages WHERE thread_id = ?").run(threadId);
  db().prepare("DELETE FROM thread_state WHERE thread_id = ?").run(threadId);
}

export interface SearchHit {
  threadId: string;
  messageId: string;
  at: number;
  role: string;
  kind: string;
  /** the matched text, trimmed to a window around the first hit */
  snippet: string;
  /** where the match sits inside `snippet`, for highlighting */
  matchStart: number;
  matchLength: number;
  /** room messages: which member said it */
  from?: string;
}

/** Case-insensitive substring search over text messages, newest first.
 * A LIKE scan, deliberately: local transcripts are megabytes at most, a
 * scan is milliseconds, and it needs no FTS extension to exist. */
export function searchMessages(query: string, limit = 40, threadId?: string): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  // escape LIKE wildcards so a literal % or _ in the query stays literal
  const pattern = `%${needle.replace(/([\\%_])/g, "\\$1")}%`;
  // text messages by their text; activity chips by the tool name — "which
  // bot ran that migration" is a tool-name question. The chip's name lives
  // in the row's json; a JSON1 extract keeps this one query.
  const scope = threadId ? "thread_id = ? AND " : "";
  const statement = db().prepare(
    "SELECT thread_id, id, at, role, kind, text, json_extract(json, '$.tool.name') AS tool_name, json_extract(json, '$.from.name') AS from_name FROM messages " +
      `WHERE ${scope}((kind = 'text' AND text IS NOT NULL AND lower(text) LIKE ? ESCAPE '\\') ` +
      "   OR (kind = 'activity' AND tool_name IS NOT NULL AND lower(tool_name) LIKE ? ESCAPE '\\')) " +
      "ORDER BY at DESC LIMIT ?",
  );
  const rows = (threadId
    ? statement.all(threadId, pattern, pattern, limit)
    : statement.all(pattern, pattern, limit)) as Array<{
    thread_id: string;
    id: string;
    at: number;
    role: string;
    kind: string;
    text: string | null;
    tool_name: string | null;
    from_name: string | null;
  }>;
  return rows.map((row) => {
    const haystack = row.kind === "activity" ? (row.tool_name ?? "") : (row.text ?? "");
    const hitAt = Math.max(0, haystack.toLowerCase().indexOf(needle));
    const start = Math.max(0, hitAt - 60);
    const end = Math.min(haystack.length, hitAt + needle.length + 90);
    const head = start > 0 ? "…" : "";
    const body = haystack.slice(start, end).replace(/\s+/g, " ").trim();
    const snippet = head + body + (end < haystack.length ? "…" : "");
    // whitespace folding can shift the offset; find the match again inside
    const folded = needle.replace(/\s+/g, " ");
    const matchStart = snippet.toLowerCase().indexOf(folded);
    return {
      threadId: row.thread_id,
      messageId: row.id,
      at: row.at,
      role: row.role,
      kind: row.kind,
      snippet,
      matchStart: matchStart < 0 ? head.length : matchStart,
      // A defensive fallback must not mark arbitrary snippet text as the hit.
      matchLength: matchStart < 0 ? 0 : folded.length,
      ...(row.from_name ? { from: row.from_name } : {}),
    };
  });
}

export interface RecallHit {
  threadId: string;
  messageId: string;
  at: number;
  role: string;
  /** the matched text, with each matched term wrapped in [brackets] */
  snippet: string;
  /** room messages: which member said it */
  from?: string;
  /** a user-role line another bot delivered with ask_bot: that bot's name.
   * The stored text opens with a note saying so, but the snippet windows
   * around the match and drops it, so the reader learns it here. */
  peer?: string;
}

/** Who wrote a user-role line that reads as the user's. The structural
 * field wins; rows stored before it existed still open with the note. */
function peerAuthor(peerName: string | null, text: string): string | null {
  return peerName ?? peerProvenanceAuthor(text);
}

/** Enough of a line to see whether it opens with an ask_bot note — the
 * note's fixed wording plus a bot name — without reading the whole text. */
const PEER_NOTE_HEAD_CHARS = 160;

// Every query token must match, so a function word the model happened to
// include ("archive reference on") turns a good query into a miss. Drop
// the common ones; if that empties the query, search for what was sent.
const STOP_WORDS = new Set(
  "a an and are as at be by did do for from had has have how i in is it its of on or that the this to was we were what when where which who why with you your".split(" "),
);

/** Turn free text into an FTS5 query that cannot be misparsed: every
 * whitespace-separated token becomes a quoted string, so `AND`, `NOT`,
 * `*`, `:`, and stray quotes are searched for rather than interpreted.
 * Tokens are ANDed — FTS5's default — so a hit contains all of them. */
function ftsQuery(query: string): string | null {
  const tokens = query
    .split(/\s+/)
    .map((token) => token.replace(/"/g, "").trim())
    .filter(Boolean);
  if (!tokens.length) return null;
  const content = tokens.filter((token) => !STOP_WORDS.has(token.toLowerCase()));
  return (content.length ? content : tokens).map((token) => `"${token}"`).join(" ");
}

/** How much of a matched message rides back in a hit. Wide enough that a
 * short report reads whole; a longer one is fetched with readMessageText. */
const SNIPPET_TOKENS = 48;

/** Full text of one text message, for a session_read after a search hit.
 * Null for a missing row or a non-text kind (activity chips carry no
 * transcript text). */
export function readMessageText(
  threadId: string,
  messageId: string,
): { threadId: string; messageId: string; at: number; role: string; text: string; from?: string; peer?: string } | null {
  const row = db()
    .prepare(
      "SELECT at, role, text, json_extract(json, '$.from.name') AS from_name, " +
        "json_extract(json, '$.peerAsk.name') AS peer_name FROM messages " +
        "WHERE thread_id = ? AND id = ? AND kind = 'text' AND text IS NOT NULL",
    )
    .get(threadId, messageId) as
    | { at: number; role: string; text: string; from_name: string | null; peer_name: string | null }
    | undefined;
  if (!row) return null;
  const peer = peerAuthor(row.peer_name, row.text);
  return {
    threadId,
    messageId,
    at: row.at,
    role: row.role,
    text: row.text,
    ...(row.from_name ? { from: row.from_name } : {}),
    ...(peer ? { peer } : {}),
  };
}

/** Relevance-ranked recall over the text messages of the given threads:
 * the bot's own past conversations, best match first, not newest first.
 * bm25 rank from FTS5; the snippet is FTS5's own, windowed around the
 * matched terms. Scoping happens in SQL before LIMIT, so a busy thread
 * cannot crowd out a quieter one. */
export function recallMessages(query: string, threadIds: readonly string[], limit = 12): RecallHit[] {
  const match = ftsQuery(query);
  if (!match || !threadIds.length) return [];
  const placeholders = threadIds.map(() => "?").join(", ");
  const rows = db()
    .prepare(
      "SELECT m.thread_id, m.id, m.at, m.role, json_extract(m.json, '$.from.name') AS from_name, " +
        `json_extract(m.json, '$.peerAsk.name') AS peer_name, substr(m.text, 1, ${PEER_NOTE_HEAD_CHARS}) AS head, ` +
        `snippet(messages_fts, 0, '[', ']', '…', ${SNIPPET_TOKENS}) AS snippet ` +
        "FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid " +
        `WHERE messages_fts MATCH ? AND m.kind = 'text' AND m.thread_id IN (${placeholders}) ` +
        "ORDER BY bm25(messages_fts), m.at DESC LIMIT ?",
    )
    .all(match, ...threadIds, limit) as Array<{
    thread_id: string;
    id: string;
    at: number;
    role: string;
    from_name: string | null;
    peer_name: string | null;
    head: string;
    snippet: string;
  }>;
  return rows.map((row) => {
    const peer = peerAuthor(row.peer_name, row.head);
    return {
      threadId: row.thread_id,
      messageId: row.id,
      at: row.at,
      role: row.role,
      snippet: row.snippet.replace(/\s+/g, " ").trim(),
      ...(row.from_name ? { from: row.from_name } : {}),
      ...(peer ? { peer } : {}),
    };
  });
}

/** Test/shutdown hook — closes the handle so a wiped DATA_DIR starts clean. */
export function closeMessageDb(): void {
  try {
    handle?.close();
  } catch {}
  handle = null;
  handlePath = null;
}
