// The record travels whole in the json column and is validated on every read: a row from another build is refused, never half-read.
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { z } from "zod";

import { APPROVAL_MODES } from "../../shared/approval-mode.ts";
import { timeBlocking } from "../perf/loop-stalls.ts";
import { TERMINAL, type Assignment, type AssignmentEvent, type EventKind, type InboxItem, type Owner } from "./types.ts";

const evidenceSchema = z.object({
  commands: z.number().int().nonnegative().optional(),
  filesChanged: z.array(z.string()).optional(),
  toolCalls: z.number().int().nonnegative().optional(),
  summary: z.string().optional(),
  okToolCalls: z.number().int().nonnegative().optional(),
  errors: z.array(z.string()).optional(),
  outward: z.array(z.string()).optional(),
});

const assignmentSchema = z.object({
  id: z.string().min(1),
  rootId: z.string().min(1),
  parentId: z.string().min(1).optional(),
  depth: z.number().int().nonnegative(),
  origin: z.object({
    kind: z.enum(["person", "routine", "outside"]),
    source: z.enum(["chat", "routine", "webhook", "relay", "external_runtime", "guest", "peer", "api"]),
    ref: z.string().optional(),
    quote: z.string().optional(),
    onBehalfOf: z.string().optional(),
  }),
  requester: z.object({
    kind: z.enum(["person", "bot_turn", "routine_run", "external_runtime"]),
    botId: z.string().optional(),
    threadId: z.string().optional(),
    runId: z.string().optional(),
    chief: z.boolean().optional(),
  }),
  assignee: z.object({
    botId: z.string().min(1),
    destination: z.object({
      kind: z.enum(["work_thread", "standing_thread", "room_thread"]),
      threadId: z.string(),
      groupId: z.string().optional(),
    }).refine(d => d.threadId.length > 0 || d.kind === "standing_thread", { message: "threadId must not be empty" }),
  }),
  mode: z.enum(["work", "consult", "notify"]),
  reply: z.enum(["resume", "poll", "none"]),
  brief: z.string(),
  doneWhen: z.string().optional(),
  goalRunId: z.string().optional(),
  status: z.enum(["queued", "running", "needs_input", "waiting", "resume", "completed", "failed", "cancelled"]),
  outcome: z.enum(["done", "needs_input", "cap_continued", "stalled", "interrupted", "budget", "provider_error", "denied",
    "expired", "stopped", "refused", "duplicate"]).optional(),
  outcomeDetail: z.string().optional(),
  fault: z.enum(["process_start", "out_of_room", "disk_full", "tool_server", "signed_out", "bot_memory"]).optional(),
  level: z.enum(APPROVAL_MODES),
  levelSource: z.enum(["own", "chief", "engine_cap"]),
  executions: z.number().int().nonnegative(),
  restarts: z.number().int().nonnegative(),
  restart: z.enum(["rerun", "cut", "teammates"]).optional(),
  createdAt: z.number(),
  startedAt: z.number().optional(),
  lastActivityAt: z.number(),
  finishedAt: z.number().optional(),
  result: z.string(),
  resultChars: z.number().int().nonnegative().optional(),
  evidence: evidenceSchema.optional(),
  statusOnly: z.boolean().optional(),
  reportedAt: z.number().optional(),
  rework: z.boolean(),
  question: z.string().optional(),
  remindedAt: z.number().optional(),
  decide: z.object({ default: z.string().optional() }).optional(),
  answer: z.string().optional(),
  answeredBy: z.discriminatedUnion("kind", [z.object({ kind: z.literal("bot"), botId: z.string().min(1) }), z.object({ kind: z.literal("default") })]).optional(),
  budgets: z.object({ since: z.number(), requests: z.number(), executions: z.number(), wakes: z.number(), total: z.number().optional(), failed: z.number().optional() }).optional(),
  // The schema strips any field it does not name: every optional Assignment field must be listed here.
  cards: z.array(z.string()).optional(),
  continuation: z.object({ note: z.string(), handoffPath: z.string().optional(), count: z.number().int().nonnegative() }).optional(),
  guard: z.object({ stale: z.number().int().nonnegative(), errors: z.array(z.string()) }).optional(),
  carrying: z.array(z.string()).optional(),
  approved: z.boolean().optional(),
  batchKey: z.string().optional(),
  fanOut: z.string().optional(),
  version: z.literal(1),
});

export interface RuntimeStore {
  readonly path: string;
  get(id: string): Assignment | undefined;
  /** Direct children, createdAt order. */
  children(id: string): Assignment[];
  root(id: string): Assignment | undefined;
  /** `openSince`: only rows not finished before that time. */
  all(filter?: { rootId?: string; nonTerminal?: boolean; ownerThreadId?: string; assignee?: { botId: string; threadId: string };
    assigneeThreadId?: string; roots?: boolean; openSince?: number }): Assignment[];
  insert(a: Assignment, event: { kind: EventKind; detail?: string; at?: number }): void;
  update(a: Assignment, event?: { kind: EventKind; detail?: string; at?: number }): void;
  /** Nested calls join the outer transaction (a savepoint inside it). */
  transaction<T>(fn: () => T): T;
  /** Oldest first. */
  events(assignmentId: string): AssignmentEvent[];
  addInbox(item: InboxItem): void;
  inbox(owner: Owner, undeliveredOnly?: boolean): InboxItem[];
  markDelivered(ids: string[], at: number): void;
  /** A result longer than the record holds, kept beside it (up to RESULT_KEPT_MAX); undefined drops it. `total` is the
   * result's own length when `text` is already a cut of it, so the reader still says the end was not kept. */
  keepResult(assignmentId: string, text: string | undefined, total?: number): void;
  /** Part of a kept result: `total` is the result's own length, `kept` how much of it was stored. */
  resultPart(assignmentId: string, offset: number, limit: number): { text: string; total: number; kept: number } | undefined;
  prune(before: number): number;
  close(): void;
}

const terminalList = TERMINAL.map(s => `'${s}'`).join(", ");
/** SQLite uses a partial index only for a WHERE that repeats its term, so assignments_live and all({ nonTerminal }) share this. */
const LIVE = `status NOT IN (${terminalList})`;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS assignments (
    id TEXT PRIMARY KEY,
    root_id TEXT NOT NULL,
    parent_id TEXT,
    status TEXT NOT NULL,
    requester_thread_id TEXT,
    requester_run_id TEXT,
    assignee_bot_id TEXT NOT NULL,
    assignee_thread_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    finished_at INTEGER,
    json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS assignments_root ON assignments(root_id);
  CREATE INDEX IF NOT EXISTS assignments_parent ON assignments(parent_id);
  CREATE INDEX IF NOT EXISTS assignments_status ON assignments(status);
  CREATE INDEX IF NOT EXISTS assignments_requester_thread ON assignments(requester_thread_id);
  CREATE INDEX IF NOT EXISTS assignments_requester_run ON assignments(requester_run_id);
  CREATE INDEX IF NOT EXISTS assignments_assignee ON assignments(assignee_bot_id, assignee_thread_id);
  CREATE INDEX IF NOT EXISTS assignments_assignee_thread ON assignments(assignee_thread_id, created_at);
  -- The live rows in all()'s order. NOT IN cannot use assignments_status, so
  -- without this every nonTerminal read walks the ended rows too, and those
  -- only grow (#2765). Created on every open, so an existing file gets it too;
  -- IF NOT EXISTS keeps an older definition, so a change to TERMINAL renames it.
  CREATE INDEX IF NOT EXISTS assignments_live ON assignments(created_at) WHERE ${LIVE};
  CREATE TABLE IF NOT EXISTS assignment_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    assignment_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    detail TEXT
  );
  CREATE INDEX IF NOT EXISTS assignment_events_assignment ON assignment_events(assignment_id, id);
  CREATE TABLE IF NOT EXISTS inbox (
    id TEXT PRIMARY KEY,
    owner_bot_id TEXT,
    owner_thread_id TEXT,
    owner_run_id TEXT,
    assignment_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS inbox_thread ON inbox(owner_thread_id, delivered_at);
  CREATE INDEX IF NOT EXISTS inbox_run ON inbox(owner_run_id, delivered_at);
  CREATE INDEX IF NOT EXISTS inbox_assignment ON inbox(assignment_id);
  -- A result past the record's own 12 000 characters, whole, in parts of RESULT_CHUNK so a page reads only the parts it
  -- covers. An older build never reads it and keeps the record's head.
  CREATE TABLE IF NOT EXISTS assignment_result_parts (
    assignment_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    start INTEGER NOT NULL,
    size INTEGER NOT NULL,
    total INTEGER NOT NULL,
    kept INTEGER NOT NULL,
    text TEXT NOT NULL,
    PRIMARY KEY (assignment_id, seq)
  );
`;

/** At most `max` units of `text`, never ending on the first half of a surrogate pair. */
function wholeCharacters(text: string, max: number): string {
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return cut.length === max && text.length > max && last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** The most of one result kept beside its record; past it the reader is told the rest was not kept. */
export const RESULT_KEPT_MAX = 2_000_000;
/** The most of one stored part of a kept result. Offsets are UTF-16 units as JavaScript counts them, so they match the
 * record's head; a part never ends inside a surrogate pair, which SQLite would store as a replacement character. */
const RESULT_CHUNK = 16_000;

type Row = Record<string, unknown>;

/** A parsed row is remembered by its JSON text: the parse is a pure function of that text, so a changed
 * row (different text) can never hit a stale entry. Callers get a clone, so none can alter another's copy. */
const ASSIGNMENT_MEMO_LIMIT = 8_192;
/** Rows hold briefs and results of any length, and every update leaves its old text behind, so the memo is also capped
 * by the row text it holds, least recently read first. */
const ASSIGNMENT_MEMO_CHARS = 8_000_000;
const assignmentMemo = new Map<string, Assignment>();
let assignmentMemoChars = 0;

function readAssignment(row: Row): Assignment {
  const memoKey = String(row.json);
  const memo = assignmentMemo.get(memoKey);
  if (memo !== undefined) {
    assignmentMemo.delete(memoKey);
    assignmentMemo.set(memoKey, memo);
    return structuredClone(memo);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(memoKey);
  } catch (error) {
    throw new Error(`runtime.db: assignment ${String(row.id)} holds invalid JSON (${String(error)})`);
  }
  const result = assignmentSchema.safeParse(parsed);
  if (!result.success) throw new Error(`runtime.db: assignment ${String(row.id)} does not match the record schema: ${result.error.message}`);
  if (memoKey.length > ASSIGNMENT_MEMO_CHARS / 64) return result.data;
  assignmentMemo.set(memoKey, structuredClone(result.data));
  assignmentMemoChars += memoKey.length;
  for (const oldest of assignmentMemo.keys()) {
    if (assignmentMemo.size <= ASSIGNMENT_MEMO_LIMIT && assignmentMemoChars <= ASSIGNMENT_MEMO_CHARS) break;
    assignmentMemo.delete(oldest);
    assignmentMemoChars -= oldest.length;
  }
  return result.data;
}

const toJson = (a: Assignment): string => JSON.stringify(a);

function readInbox(row: Row): InboxItem {
  const item: InboxItem = {
    id: String(row.id), assignmentId: String(row.assignment_id),
    kind: row.kind as InboxItem["kind"], createdAt: Number(row.created_at),
  };
  if (row.owner_bot_id != null) item.ownerBotId = String(row.owner_bot_id);
  if (row.owner_thread_id != null) item.ownerThreadId = String(row.owner_thread_id);
  if (row.owner_run_id != null) item.ownerRunId = String(row.owner_run_id);
  if (row.delivered_at != null) item.deliveredAt = Number(row.delivered_at);
  return item;
}

function readEvent(row: Row): AssignmentEvent {
  const event: AssignmentEvent = {
    id: Number(row.id), assignmentId: String(row.assignment_id), at: Number(row.at), kind: row.kind as EventKind,
  };
  if (row.detail != null) event.detail = String(row.detail);
  return event;
}

export function openRuntimeStore(path: string): RuntimeStore {
  const memory = path === ":memory:";
  if (!memory) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Briefs and results are private: owner-only from the first byte, repaired on a file that inherited a loose umask.
    closeSync(openSync(path, "a", 0o600));
    try {
      chmodSync(path, 0o600);
    } catch {}
  }
  const db = new DatabaseSync(path);
  if (!memory) {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
  }
  db.exec(SCHEMA);

  const statements = {
    get: db.prepare("SELECT id, json FROM assignments WHERE id = ?"),
    children: db.prepare("SELECT id, json FROM assignments WHERE parent_id = ? ORDER BY created_at, rowid"),
    insert: db.prepare(`INSERT INTO assignments (id, root_id, parent_id, status, requester_thread_id, requester_run_id,
      assignee_bot_id, assignee_thread_id, created_at, finished_at, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    update: db.prepare(`UPDATE assignments SET root_id = ?, parent_id = ?, status = ?, requester_thread_id = ?,
      requester_run_id = ?, assignee_bot_id = ?, assignee_thread_id = ?, created_at = ?, finished_at = ?, json = ? WHERE id = ?`),
    event: db.prepare("INSERT INTO assignment_events (assignment_id, at, kind, detail) VALUES (?, ?, ?, ?)"),
    events: db.prepare("SELECT id, assignment_id, at, kind, detail FROM assignment_events WHERE assignment_id = ? ORDER BY id"),
    addInbox: db.prepare(`INSERT INTO inbox (id, owner_bot_id, owner_thread_id, owner_run_id, assignment_id, kind, created_at, delivered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    deliver: db.prepare("UPDATE inbox SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL"),
    prunable: db.prepare(`SELECT id FROM assignments r WHERE r.parent_id IS NULL AND r.status IN (${terminalList})
      AND r.finished_at IS NOT NULL AND r.finished_at < ?
      AND NOT EXISTS (SELECT 1 FROM assignments c WHERE c.root_id = r.id AND c.status NOT IN (${terminalList}))`),
    pruneEvents: db.prepare("DELETE FROM assignment_events WHERE assignment_id IN (SELECT id FROM assignments WHERE root_id = ?)"),
    pruneInbox: db.prepare("DELETE FROM inbox WHERE assignment_id IN (SELECT id FROM assignments WHERE root_id = ?)"),
    pruneResults: db.prepare("DELETE FROM assignment_result_parts WHERE assignment_id IN (SELECT id FROM assignments WHERE root_id = ?)"),
    pruneRows: db.prepare("DELETE FROM assignments WHERE root_id = ?"),
    // Rows an older build's prune left behind once their record was gone.
    pruneOrphanResults: db.prepare("DELETE FROM assignment_result_parts WHERE assignment_id NOT IN (SELECT id FROM assignments)"),
    keepResultPart: db.prepare("INSERT INTO assignment_result_parts (assignment_id, seq, start, size, total, kept, text) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    dropResult: db.prepare("DELETE FROM assignment_result_parts WHERE assignment_id = ?"),
    resultSize: db.prepare("SELECT total, kept FROM assignment_result_parts WHERE assignment_id = ? AND seq = 0"),
    resultParts: db.prepare("SELECT start, text FROM assignment_result_parts WHERE assignment_id = ? AND start < ? AND start + size > ? ORDER BY seq"),
  };

  let depth = 0;
  function transaction<T>(fn: () => T): T {
    if (depth > 0) {
      const savepoint = `runtime_${depth}`;
      db.exec(`SAVEPOINT ${savepoint}`);
      depth += 1;
      try {
        const result = fn();
        db.exec(`RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        db.exec(`ROLLBACK TO ${savepoint}`);
        db.exec(`RELEASE ${savepoint}`);
        throw error;
      } finally { depth -= 1; }
    }
    db.exec("BEGIN IMMEDIATE");
    depth = 1;
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    } finally { depth = 0; }
  }

  const columns = (a: Assignment): SQLInputValue[] => [
    a.rootId, a.parentId ?? null, a.status, a.requester.threadId ?? null, a.requester.runId ?? null,
    a.assignee.botId, a.assignee.destination.threadId, a.createdAt, a.finishedAt ?? null, toJson(a),
  ];
  const writeEvent = (id: string, event: { kind: EventKind; detail?: string; at?: number }) => {
    statements.event.run(id, event.at ?? Date.now(), event.kind, event.detail ?? null);
  };

  return {
    path,
    get(id) {
      const row = statements.get.get(id) as Row | undefined;
      return row ? readAssignment(row) : undefined;
    },
    children(id) {
      return (statements.children.all(id) as Row[]).map(readAssignment);
    },
    root(id) {
      const row = statements.get.get(id) as Row | undefined;
      if (!row) return undefined;
      const a = readAssignment(row);
      if (a.rootId === a.id) return a;
      const rootRow = statements.get.get(a.rootId) as Row | undefined;
      return rootRow ? readAssignment(rootRow) : undefined;
    },
    all(filter = {}) {
      const where: string[] = [];
      const params: SQLInputValue[] = [];
      if (filter.rootId !== undefined) { where.push("root_id = ?"); params.push(filter.rootId); }
      if (filter.nonTerminal) where.push(LIVE);
      if (filter.ownerThreadId !== undefined) { where.push("requester_thread_id = ?"); params.push(filter.ownerThreadId); }
      if (filter.assignee !== undefined) {
        where.push("assignee_bot_id = ? AND assignee_thread_id = ?");
        params.push(filter.assignee.botId, filter.assignee.threadId);
      }
      if (filter.assigneeThreadId !== undefined) { where.push("assignee_thread_id = ?"); params.push(filter.assigneeThreadId); }
      if (filter.roots) where.push("parent_id IS NULL");
      if (filter.openSince !== undefined) { where.push("(finished_at IS NULL OR finished_at >= ?)"); params.push(filter.openSince); }
      const sql = `SELECT id, json FROM assignments${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, rowid`;
      return timeBlocking("runtimeReads", () => (db.prepare(sql).all(...params) as Row[]).map(readAssignment));
    },
    insert(a, event) {
      transaction(() => {
        statements.insert.run(a.id, ...columns(a));
        writeEvent(a.id, event);
      });
    },
    update(a, event) {
      transaction(() => {
        const changes = statements.update.run(...columns(a), a.id).changes;
        if (changes === 0) throw new Error(`runtime.db: assignment ${a.id} does not exist`);
        if (event) writeEvent(a.id, event);
      });
    },
    transaction,
    events(assignmentId) {
      return (statements.events.all(assignmentId) as Row[]).map(readEvent);
    },
    addInbox(item) {
      statements.addInbox.run(item.id, item.ownerBotId ?? null, item.ownerThreadId ?? null, item.ownerRunId ?? null,
        item.assignmentId, item.kind, item.createdAt, item.deliveredAt ?? null);
    },
    inbox(owner, undeliveredOnly = false) {
      const where: string[] = [];
      const params: SQLInputValue[] = [];
      if (owner.botId !== undefined) { where.push("owner_bot_id = ?"); params.push(owner.botId); }
      if (owner.threadId !== undefined) { where.push("owner_thread_id = ?"); params.push(owner.threadId); }
      if (owner.runId !== undefined) { where.push("owner_run_id = ?"); params.push(owner.runId); }
      if (where.length === 0) return [];
      if (undeliveredOnly) where.push("delivered_at IS NULL");
      const sql = `SELECT * FROM inbox WHERE ${where.join(" AND ")} ORDER BY created_at, rowid`;
      return (db.prepare(sql).all(...params) as Row[]).map(readInbox);
    },
    markDelivered(ids, at) {
      if (ids.length === 0) return;
      transaction(() => {
        for (const id of ids) statements.deliver.run(at, id);
      });
    },
    prune(before) {
      return transaction(() => {
        const roots = (statements.prunable.all(before) as Row[]).map(row => String(row.id));
        let removed = 0;
        for (const rootId of roots) {
          statements.pruneEvents.run(rootId);
          statements.pruneInbox.run(rootId);
          statements.pruneResults.run(rootId);
          removed += Number(statements.pruneRows.run(rootId).changes);
        }
        if (roots.length) statements.pruneOrphanResults.run();
        return removed;
      });
    },
    keepResult(assignmentId, text, total) {
      transaction(() => {
        statements.dropResult.run(assignmentId);
        if (text === undefined) return;
        const kept = wholeCharacters(text, RESULT_KEPT_MAX);
        const whole = Math.max(total ?? 0, text.length);
        for (let seq = 0, at = 0; seq === 0 || at < kept.length; seq += 1) {
          const part = wholeCharacters(kept.slice(at), RESULT_CHUNK);
          statements.keepResultPart.run(assignmentId, seq, at, part.length, whole, kept.length, part);
          at += part.length;
        }
      });
    },
    resultPart(assignmentId, offset, limit) {
      const size = statements.resultSize.get(assignmentId) as Row | undefined;
      if (!size) return undefined;
      const kept = Number(size.kept), total = Number(size.total);
      const start = Math.min(Math.max(0, offset), kept), end = Math.min(kept, start + Math.max(0, limit));
      if (end <= start) return { text: "", total, kept };
      const parts = statements.resultParts.all(assignmentId, end, start) as Row[];
      const from = parts.length ? Number(parts[0]!.start) : start;
      const text = parts.map(row => String(row.text)).join("").slice(start - from, end - from);
      return { text, total, kept };
    },
    close() {
      db.close();
    },
  };
}
