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
    CREATE TABLE IF NOT EXISTS delegation_tasks (
      task_id TEXT PRIMARY KEY,
      source_thread_id TEXT NOT NULL,
      to_bot_id TEXT NOT NULL,
      to_bot_name TEXT NOT NULL,
      target_thread_id TEXT,
      message TEXT NOT NULL,
      reason TEXT,
      depth INTEGER NOT NULL,
      approval_granted INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      waiting_on_busy INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL CHECK (state IN ('queued', 'launching', 'running', 'terminal')),
      terminal_status TEXT,
      terminal_result TEXT,
      finished_at INTEGER,
      source_delivery TEXT NOT NULL DEFAULT 'pending' CHECK (source_delivery IN ('pending', 'delivered', 'abandoned')),
      source_context TEXT NOT NULL DEFAULT 'pending' CHECK (source_context IN ('pending', 'acknowledged', 'abandoned')),
      source_wake TEXT NOT NULL DEFAULT 'pending' CHECK (source_wake IN ('pending', 'claimed', 'acknowledged', 'abandoned')),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS delegation_tasks_state ON delegation_tasks(state, source_thread_id);
    CREATE INDEX IF NOT EXISTS delegation_tasks_delivery ON delegation_tasks(state, source_delivery);
  `);
  // The first ledger revision shipped without context/wake outboxes. SQLite
  // cannot add their CHECK constraints with ALTER TABLE, but the values are
  // still constrained by every writer below and old rows safely default.
  const columns = db.prepare("PRAGMA table_info(delegation_tasks)").all() as Array<{ name: string }> ;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has("source_context")) db.exec("ALTER TABLE delegation_tasks ADD COLUMN source_context TEXT NOT NULL DEFAULT 'pending'");
  if (!names.has("source_wake")) db.exec("ALTER TABLE delegation_tasks ADD COLUMN source_wake TEXT NOT NULL DEFAULT 'pending'");
  return db;
}

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
  const insert = db().prepare(
    "INSERT OR REPLACE INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
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
    .prepare("INSERT OR REPLACE INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(threadId, message.id, message.at, message.role, message.kind, message.text ?? null, JSON.stringify(message));
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

export type DelegationTaskState = "queued" | "launching" | "running" | "terminal";
export type SourceDeliveryState = "pending" | "delivered" | "abandoned";
export type SourceContextState = "pending" | "acknowledged" | "abandoned";
export type SourceWakeState = "pending" | "claimed" | "acknowledged" | "abandoned";

export interface DelegationTaskRow {
  taskId: string;
  sourceThreadId: string;
  toBotId: string;
  toBotName: string;
  targetThreadId?: string;
  message: string;
  reason?: string;
  depth: number;
  approvalGranted: boolean;
  attempts: number;
  waitingOnBusy: boolean;
  state: DelegationTaskState;
  terminalStatus?: string;
  terminalResult?: string;
  finishedAt?: number;
  sourceDelivery: SourceDeliveryState;
  sourceContext: SourceContextState;
  sourceWake: SourceWakeState;
  createdAt: number;
}

function rowToDelegation(row: Record<string, unknown>): DelegationTaskRow {
  return {
    taskId: String(row.task_id), sourceThreadId: String(row.source_thread_id),
    toBotId: String(row.to_bot_id), toBotName: String(row.to_bot_name),
    ...(typeof row.target_thread_id === "string" && row.target_thread_id ? { targetThreadId: row.target_thread_id } : {}),
    message: String(row.message), ...(typeof row.reason === "string" ? { reason: row.reason } : {}),
    depth: Number(row.depth), approvalGranted: Number(row.approval_granted) === 1,
    attempts: Number(row.attempts), waitingOnBusy: Number(row.waiting_on_busy) === 1,
    state: row.state as DelegationTaskState,
    ...(typeof row.terminal_status === "string" ? { terminalStatus: row.terminal_status } : {}),
    ...(typeof row.terminal_result === "string" ? { terminalResult: row.terminal_result } : {}),
    ...(typeof row.finished_at === "number" ? { finishedAt: row.finished_at } : {}),
    sourceDelivery: (row.source_delivery === "delivered" || row.source_delivery === "abandoned") ? row.source_delivery : "pending",
    sourceContext: (row.source_context === "acknowledged" || row.source_context === "abandoned") ? row.source_context : "pending",
    sourceWake: (["claimed", "acknowledged", "abandoned"] as string[]).includes(String(row.source_wake)) ? row.source_wake as SourceWakeState : "pending",
    createdAt: Number(row.created_at),
  };
}

export function createDelegationTask(task: Omit<DelegationTaskRow, "sourceContext" | "sourceWake"> & Partial<Pick<DelegationTaskRow, "sourceContext" | "sourceWake">>): void {
  db().prepare(
    "INSERT INTO delegation_tasks (task_id, source_thread_id, to_bot_id, to_bot_name, target_thread_id, message, reason, depth, approval_granted, attempts, waiting_on_busy, state, terminal_status, terminal_result, finished_at, source_delivery, source_context, source_wake, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(task.taskId, task.sourceThreadId, task.toBotId, task.toBotName, task.targetThreadId ?? null, task.message, task.reason ?? null, task.depth, task.approvalGranted ? 1 : 0, task.attempts, task.waitingOnBusy ? 1 : 0, task.state, task.terminalStatus ?? null, task.terminalResult ?? null, task.finishedAt ?? null, task.sourceDelivery, task.sourceContext ?? "pending", task.sourceWake ?? "pending", task.createdAt);
}

export function delegationTask(taskId: string): DelegationTaskRow | null {
  const row = db().prepare("SELECT * FROM delegation_tasks WHERE task_id = ?").get(taskId) as Record<string, unknown> | undefined;
  return row ? rowToDelegation(row) : null;
}

export function delegationTasks(states?: readonly DelegationTaskState[]): DelegationTaskRow[] {
  const rows = states?.length
    ? db().prepare(`SELECT * FROM delegation_tasks WHERE state IN (${states.map(() => "?").join(",")}) ORDER BY created_at`).all(...states) as Record<string, unknown>[]
    : db().prepare("SELECT * FROM delegation_tasks ORDER BY created_at").all() as Record<string, unknown>[];
  return rows.map(rowToDelegation);
}

/** Non-terminal bookkeeping only. Terminal settlement must use settleDelegationTask. */
export function updateDelegationTask(taskId: string, patch: Partial<Pick<DelegationTaskRow, "targetThreadId" | "attempts" | "waitingOnBusy" | "state">>): boolean {
  const current = delegationTask(taskId);
  if (!current || current.state === "terminal") return false;
  const next = { ...current, ...patch };
  const result = db().prepare("UPDATE delegation_tasks SET target_thread_id = ?, attempts = ?, waiting_on_busy = ?, state = ? WHERE task_id = ? AND state != 'terminal'")
    .run(next.targetThreadId ?? null, next.attempts, next.waitingOnBusy ? 1 : 0, next.state, taskId) as { changes?: number };
  return result.changes === 1;
}

/** First terminal outcome wins. This CAS is the sole terminal transition;
 * later provider events/restarts must never reopen delivery or replace output. */
export function settleDelegationTask(taskId: string, status: string, result: string | undefined, finishedAt = Date.now()): DelegationTaskRow | null {
  const database = db();
  database.exec("BEGIN IMMEDIATE");
  try {
    const write = database.prepare("UPDATE delegation_tasks SET state = 'terminal', terminal_status = ?, terminal_result = ?, finished_at = ?, source_delivery = 'pending', source_context = 'pending', source_wake = 'pending' WHERE task_id = ? AND state != 'terminal'")
      .run(status, result ?? null, finishedAt, taskId) as { changes?: number };
    if (write.changes !== 1) { database.exec("COMMIT"); return null; }
    const row = database.prepare("SELECT * FROM delegation_tasks WHERE task_id = ?").get(taskId) as Record<string, unknown>;
    database.exec("COMMIT");
    return rowToDelegation(row);
  } catch (error) { database.exec("ROLLBACK"); throw error; }
}

/** Claim a queued task before provider dispatch. A crash after this write is
 * terminalized at boot rather than risking a second external worker. */
export function claimDelegationLaunch(taskId: string, targetThreadId: string): boolean {
  const result = db().prepare("UPDATE delegation_tasks SET state = 'launching', target_thread_id = ? WHERE task_id = ? AND state = 'queued'").run(targetThreadId, taskId) as { changes?: number };
  return result.changes === 1;
}

export function terminalizeInterruptedDelegations(reason: string): DelegationTaskRow[] {
  const candidates = delegationTasks(["launching", "running"]);
  const settled: DelegationTaskRow[] = [];
  for (const task of candidates) {
    const winner = settleDelegationTask(task.taskId, "failed", reason);
    if (winner) settled.push(winner);
  }
  return settled;
}

/** Append a stable terminal message and acknowledge delivery atomically. */
export function appendDelegationDelivery(threadId: string, taskId: string, message: Message): { inserted: boolean } {
  const database = db(); database.exec("BEGIN IMMEDIATE");
  try {
    const task = database.prepare("SELECT state, source_thread_id, source_delivery FROM delegation_tasks WHERE task_id = ?").get(taskId) as { state: string; source_thread_id: string; source_delivery: string } | undefined;
    if (!task || task.state !== "terminal" || task.source_thread_id !== threadId || task.source_delivery === "abandoned") throw new Error("delegation is not deliverable for this thread");
    const result = database.prepare("INSERT OR IGNORE INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(threadId, message.id, message.at, message.role, message.kind, message.text ?? null, JSON.stringify(message)) as { changes?: number };
    const inserted = result.changes === 1;
    if (inserted) setActiveLeaf(threadId, message.id);
    database.prepare("UPDATE delegation_tasks SET source_delivery = 'delivered' WHERE task_id = ?").run(taskId);
    database.exec("COMMIT"); return { inserted };
  } catch (error) { database.exec("ROLLBACK"); throw error; }
}

export function acknowledgeDelegationContext(taskId: string): boolean {
  const result = db().prepare("UPDATE delegation_tasks SET source_context = 'acknowledged' WHERE task_id = ? AND state = 'terminal' AND source_delivery = 'delivered' AND source_context = 'pending'").run(taskId) as { changes?: number };
  return result.changes === 1;
}

/** Claim before calling startTurn. A claimed wake is never replayed after a
 * process crash because provider turns lack an idempotency key. */
export function claimDelegationWake(taskId: string): boolean {
  const result = db().prepare("UPDATE delegation_tasks SET source_wake = 'claimed' WHERE task_id = ? AND state = 'terminal' AND source_delivery = 'delivered' AND source_context = 'acknowledged' AND source_wake = 'pending'").run(taskId) as { changes?: number };
  return result.changes === 1;
}
export function acknowledgeDelegationWake(taskId: string): void {
  db().prepare("UPDATE delegation_tasks SET source_wake = 'acknowledged' WHERE task_id = ? AND source_wake = 'claimed'").run(taskId);
}
/** startTurn rejected before provider dispatch (usually a race with a user
 * turn), so this claim is safe to retry when the source becomes idle. */
export function releaseDelegationWakeClaim(taskId: string): void {
  db().prepare("UPDATE delegation_tasks SET source_wake = 'pending' WHERE task_id = ? AND source_wake = 'claimed'").run(taskId);
}
export function abandonDelegationDelivery(taskId: string): void {
  db().prepare("UPDATE delegation_tasks SET source_delivery = CASE WHEN source_delivery = 'pending' THEN 'abandoned' ELSE source_delivery END, source_context = CASE WHEN source_context = 'pending' THEN 'abandoned' ELSE source_context END, source_wake = CASE WHEN source_wake IN ('pending', 'claimed') THEN 'abandoned' ELSE source_wake END WHERE task_id = ? AND state = 'terminal'").run(taskId);
}

/** Remove every remaining responsibility for a source thread before its bot
 * or task is deleted. A single statement makes queued/ambiguous work terminal
 * and abandons every outbox without ever appending into the doomed transcript.
 * Existing terminal outcomes retain their first-wins result; only their
 * undeliverable source effects are abandoned. */
export function abandonDelegationsForSourceThread(sourceThreadId: string, reason: string): number {
  const result = db().prepare(
    "UPDATE delegation_tasks SET " +
    "state = CASE WHEN state = 'terminal' THEN state ELSE 'terminal' END, " +
    "terminal_status = CASE WHEN state = 'terminal' THEN terminal_status ELSE 'dropped' END, " +
    "terminal_result = CASE WHEN state = 'terminal' THEN terminal_result ELSE ? END, " +
    "finished_at = CASE WHEN state = 'terminal' THEN finished_at ELSE ? END, " +
    "source_delivery = 'abandoned', source_context = 'abandoned', source_wake = 'abandoned' " +
    "WHERE source_thread_id = ?",
  ).run(reason, Date.now(), sourceThreadId) as { changes?: number };
  return result.changes ?? 0;
}
export function pendingDelegationDeliveries(): DelegationTaskRow[] {
  return (db().prepare("SELECT * FROM delegation_tasks WHERE state = 'terminal' AND (source_delivery = 'pending' OR (source_delivery = 'delivered' AND (source_context = 'pending' OR source_wake = 'pending' OR source_wake = 'claimed'))) ORDER BY finished_at, created_at").all() as Record<string, unknown>[]).map(rowToDelegation);
}
/** Discard old terminal payloads only after the same retention period used by
 * receipts. Delivered/abandoned rows are no longer needed for recovery. */
export function pruneDelegationTasks(cutoff: number, keep = 100): void {
  const database = db();
  database.prepare("DELETE FROM delegation_tasks WHERE task_id IN (SELECT task_id FROM delegation_tasks WHERE state = 'terminal' AND source_delivery IN ('delivered', 'abandoned') AND source_wake IN ('acknowledged', 'abandoned') AND finished_at < ? ORDER BY finished_at DESC LIMIT -1 OFFSET ?)").run(cutoff, keep);
}
/** Mark previously claimed wakes as interrupted without rerunning a possibly
 * externally visible provider turn. The caller appends an explicit activity. */
export function abandonClaimedDelegationWake(taskId: string): boolean {
  const result = db().prepare("UPDATE delegation_tasks SET source_wake = 'abandoned' WHERE task_id = ? AND state = 'terminal' AND source_wake = 'claimed'").run(taskId) as { changes?: number };
  return result.changes === 1;
}

/** Persist the conservative notice used after a crash interrupts a claimed
 * source wake. It shares the state transition so restart retries cannot
 * create duplicate activity chips. */
export function appendDelegationWakeInterrupted(threadId: string, taskId: string, message: Message): { inserted: boolean } {
  const database = db(); database.exec("BEGIN IMMEDIATE");
  try {
    const claimed = database.prepare("UPDATE delegation_tasks SET source_wake = 'abandoned' WHERE task_id = ? AND state = 'terminal' AND source_thread_id = ? AND source_wake = 'claimed'").run(taskId, threadId) as { changes?: number };
    if (claimed.changes !== 1) { database.exec("COMMIT"); return { inserted: false }; }
    const result = database.prepare("INSERT OR IGNORE INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(threadId, message.id, message.at, message.role, message.kind, message.text ?? null, JSON.stringify(message)) as { changes?: number };
    if (result.changes === 1) setActiveLeaf(threadId, message.id);
    database.exec("COMMIT"); return { inserted: result.changes === 1 };
  } catch (error) { database.exec("ROLLBACK"); throw error; }
}

/** Test/shutdown hook — closes the handle so a wiped DATA_DIR starts clean. */
export function closeMessageDb(): void {
  try {
    handle?.close();
  } catch {}
  handle = null;
  handlePath = null;
}
