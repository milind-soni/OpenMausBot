// The record travels whole in the json column and is validated on every read: a row from another build is refused, never half-read.
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { z } from "zod";

import { APPROVAL_MODES } from "../../shared/approval-mode.ts";
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
  evidence: evidenceSchema.optional(),
  reportedAt: z.number().optional(),
  rework: z.boolean(),
  question: z.string().optional(),
  answer: z.string().optional(),
  budgets: z.object({ since: z.number(), requests: z.number(), executions: z.number(), wakes: z.number() }).optional(),
  // The schema strips any field it does not name: every optional Assignment field must be listed here.
  cards: z.array(z.string()).optional(),
  continuation: z.object({ note: z.string(), handoffPath: z.string().optional(), count: z.number().int().nonnegative() }).optional(),
  guard: z.object({ stale: z.number().int().nonnegative(), errors: z.array(z.string()) }).optional(),
  carrying: z.array(z.string()).optional(),
  approved: z.boolean().optional(),
  batchKey: z.string().optional(),
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
    roots?: boolean; openSince?: number }): Assignment[];
  insert(a: Assignment, event: { kind: EventKind; detail?: string; at?: number }): void;
  update(a: Assignment, event?: { kind: EventKind; detail?: string; at?: number }): void;
  /** Nested calls join the outer transaction (a savepoint inside it). */
  transaction<T>(fn: () => T): T;
  /** Oldest first. */
  events(assignmentId: string): AssignmentEvent[];
  addInbox(item: InboxItem): void;
  inbox(owner: Owner, undeliveredOnly?: boolean): InboxItem[];
  markDelivered(ids: string[], at: number): void;
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
`;

type Row = Record<string, unknown>;

function readAssignment(row: Row): Assignment {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(row.json));
  } catch (error) {
    throw new Error(`runtime.db: assignment ${String(row.id)} holds invalid JSON (${String(error)})`);
  }
  const result = assignmentSchema.safeParse(parsed);
  if (!result.success) throw new Error(`runtime.db: assignment ${String(row.id)} does not match the record schema: ${result.error.message}`);
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
    pruneRows: db.prepare("DELETE FROM assignments WHERE root_id = ?"),
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
      if (filter.roots) where.push("parent_id IS NULL");
      if (filter.openSince !== undefined) { where.push("(finished_at IS NULL OR finished_at >= ?)"); params.push(filter.openSince); }
      const sql = `SELECT id, json FROM assignments${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, rowid`;
      return (db.prepare(sql).all(...params) as Row[]).map(readAssignment);
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
          removed += Number(statements.pruneRows.run(rootId).changes);
        }
        return removed;
      });
    },
    close() {
      db.close();
    },
  };
}
