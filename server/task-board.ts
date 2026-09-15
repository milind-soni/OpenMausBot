// A durable work queue for the fleet.
//
// delegate_bot hands one message to one peer and forgets it; a routine
// re-runs a prompt on a clock. Neither can express "this piece of work
// exists, it is not done, someone should pick it up, and it is still
// true after a restart". That is what this table is.
//
// node:sqlite for the same reason message-db.ts uses it: built into
// Node >= 23.4, so the packaged app gains no native dependency.
//
// Scope: this module owns the table set, the status state machine,
// dependency links, and comments — claim/heartbeat/reclaim as far as they
// are storage primitives on a task row. It does no dispatching and knows
// nothing about HTTP; the tick that decides what to promote, claim, or
// reclaim is a separate module built on top of this one.
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";

export type BoardStatus = "todo" | "ready" | "running" | "blocked" | "review" | "done" | "archived";

/** Every legal status, in the order the plan lists them — for validating an
 * untrusted status string (an HTTP PATCH body, a tool argument) before it
 * reaches a typed BoardStatus parameter. */
export const BOARD_STATUSES: readonly BoardStatus[] = [
  "todo",
  "ready",
  "running",
  "blocked",
  "review",
  "done",
  "archived",
];

/** Input caps, in step with the rest of the server (internal thread titles
 * cap at 80, a room post at ROOM_POST_MAX_CHARS). Both bot-facing and
 * human-facing write paths validate against these and answer 400; the
 * writers below also clamp, so storage can never hold an unbounded row even
 * if a future call site forgets to check. A looping bot would otherwise
 * write rows of any size that GET /api/tasks reads back and SSE broadcasts. */
export const TASK_TITLE_MAX = 200;
export const TASK_BODY_MAX = 8_000;
export const TASK_COMMENT_MAX = 4_000;

/** How many comments a single read returns by default. Comments are loaded
 * per task (GET /api/tasks/:id/comments), never all-of-every-task inside a
 * list response. */
export const TASK_COMMENT_PAGE = 100;

const clamp = (text: string, max: number): string => (text.length > max ? text.slice(0, max) : text);

export interface BoardTask {
  id: string;
  title: string;
  body: string;
  status: BoardStatus;
  assigneeBotId: string | null;
  createdByBotId: string | null;
  priority: number; // 0 = normal, higher runs first
  threadId: string | null; // the turn this task ran in, once it has run
  result: string | null;
  blockedReason: string | null;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  heartbeatAt: number | null;
  finishedAt: number | null;
  /** Phase 2 part 1: who is responsible — a bot id, or "person". */
  owner: string | null;
  /** When it is due, ms since the epoch; null when it has no date. */
  dueAt: number | null;
  /** The money cap (decision 11); null means no cap. */
  budgetUsd: number | null;
  /** What the harness has booked against it from usage rows, in USD. */
  spentUsd: number;
  /** Turns in its thread that reported no price and so booked nothing (#59's rule). */
  unpricedTurns: number;
}

/** The reason a task paused for money carries; a raised cap resumes it. */
export const BUDGET_PAUSED_REASON = "paused, needs a budget increase";
/** The share of the cap at which one warning comment is posted. */
export const BUDGET_WARN_SHARE = 0.7;

export interface BoardComment {
  id: number;
  taskId: string;
  botId: string | null;
  text: string;
  at: number;
}

export interface CreateTaskInput {
  title: string;
  body?: string;
  assigneeBotId?: string | null;
  createdByBotId?: string | null;
  priority?: number;
  parentIds?: string[];
  owner?: string | null;
  dueAt?: number | null;
  budgetUsd?: number | null;
}

export interface StatusPatch {
  result?: string;
  blockedReason?: string;
  threadId?: string;
}

/** Fields a human (or a future assignment tool) can edit without moving the
 * task through the status machine. `assigneeBotId: null` clears an
 * assignment; omitting the field entirely leaves it untouched — the two
 * are not the same request. */
export interface TaskPatch {
  title?: string;
  body?: string;
  assigneeBotId?: string | null;
  priority?: number;
  /** Tri-state like assigneeBotId: omitted leaves it, null clears it. */
  owner?: string | null;
  dueAt?: number | null;
  /** A cap below what is already spent is refused; raising the cap on a
   * task paused for money moves it back to ready. */
  budgetUsd?: number | null;
}

/** The only legal moves. Everything else throws, including the ones that
 * look harmless — "done → running" would silently re-run accepted work. */
const TRANSITIONS: Record<BoardStatus, BoardStatus[]> = {
  todo: ["ready", "archived"],
  ready: ["running", "blocked", "archived"],
  running: ["review", "blocked", "ready"],
  blocked: ["ready", "archived"],
  review: ["done", "ready", "archived"],
  done: ["archived"],
  archived: [],
};

let db: DatabaseSync | null = null;
let file = "";

export function boardFile(): string {
  return file;
}

/** The live handle. Every other function in this module goes through this
 * so a missing openBoard() call fails loudly instead of touching nothing. */
function handle(): DatabaseSync {
  if (!db) throw new Error("task board not open — call openBoard() first");
  return db;
}

export function openBoard(path: string = join(DATA_DIR, "tasks.db")): void {
  try {
    db?.close();
  } catch {
    // already closed, or the underlying file is gone — nothing to do
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Task titles and bodies carry whatever the user or a bot typed. Create
  // the database with owner-only permissions and also repair an existing
  // file that may have inherited a permissive umask — the same approach
  // message-db.ts uses for messages.db.
  closeSync(openSync(path, "a", 0o600));
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort repair; a read-only filesystem should not block opening
  }
  db = new DatabaseSync(path);
  file = path;
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      assignee_bot_id TEXT,
      created_by_bot_id TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      thread_id TEXT,
      result TEXT,
      blocked_reason TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      heartbeat_at INTEGER,
      finished_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS task_links (
      parent_id TEXT NOT NULL,
      child_id TEXT NOT NULL,
      PRIMARY KEY (parent_id, child_id)
    );
    CREATE TABLE IF NOT EXISTS task_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      bot_id TEXT,
      text TEXT NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tasks_status ON tasks (status, priority DESC, created_at DESC);
    CREATE INDEX IF NOT EXISTS task_links_child ON task_links (child_id);
    CREATE INDEX IF NOT EXISTS task_comments_task ON task_comments (task_id, id);
  `);
  // Phase 2 part 1 columns, added to a board written before them. ADD COLUMN
  // is the one migration SQLite does in place; each is guarded by the table
  // description so a reopen is a no-op.
  const present = new Set((db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name));
  const wanted: Array<[string, string]> = [
    ["owner", "TEXT"],
    ["due_at", "INTEGER"],
    ["budget_usd", "REAL"],
    ["spent_usd", "REAL NOT NULL DEFAULT 0"],
    ["unpriced_turns", "INTEGER NOT NULL DEFAULT 0"],
    ["budget_warned", "INTEGER NOT NULL DEFAULT 0"],
  ];
  for (const [column, type] of wanted) if (!present.has(column)) db.exec(`ALTER TABLE tasks ADD COLUMN ${column} ${type}`);
  db.exec("CREATE INDEX IF NOT EXISTS tasks_thread ON tasks (thread_id, updated_at DESC)");
}

interface TaskRow {
  id: string;
  title: string;
  body: string;
  status: BoardStatus;
  assignee_bot_id: string | null;
  created_by_bot_id: string | null;
  priority: number;
  thread_id: string | null;
  result: string | null;
  blocked_reason: string | null;
  attempts: number;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  heartbeat_at: number | null;
  finished_at: number | null;
  owner: string | null;
  due_at: number | null;
  budget_usd: number | null;
  spent_usd: number;
  unpriced_turns: number;
  budget_warned: number;
}

function rowToTask(row: TaskRow): BoardTask {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    status: row.status,
    assigneeBotId: row.assignee_bot_id,
    createdByBotId: row.created_by_bot_id,
    priority: row.priority,
    threadId: row.thread_id,
    result: row.result,
    blockedReason: row.blocked_reason,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    finishedAt: row.finished_at,
    owner: row.owner ?? null,
    dueAt: row.due_at ?? null,
    budgetUsd: row.budget_usd ?? null,
    spentUsd: row.spent_usd ?? 0,
    unpricedTurns: row.unpriced_turns ?? 0,
  };
}

export function createTask(input: CreateTaskInput): BoardTask {
  const id = newId();
  const now = Date.now();
  handle()
    .prepare(`
      INSERT INTO tasks (
        id, title, body, status, assignee_bot_id, created_by_bot_id,
        priority, thread_id, result, blocked_reason, attempts,
        created_at, updated_at, started_at, heartbeat_at, finished_at,
        owner, due_at, budget_usd
      ) VALUES (?, ?, ?, 'todo', ?, ?, ?, NULL, NULL, NULL, 0, ?, ?, NULL, NULL, NULL, ?, ?, ?)
    `)
    .run(
      id,
      clamp(input.title, TASK_TITLE_MAX),
      clamp(input.body ?? "", TASK_BODY_MAX),
      input.assigneeBotId ?? null,
      input.createdByBotId ?? null,
      input.priority ?? 0,
      now,
      now,
      input.owner ?? null,
      input.dueAt ?? null,
      input.budgetUsd ?? null,
    );
  for (const parentId of input.parentIds ?? []) linkTasks(parentId, id);
  const created = getTask(id);
  if (!created) throw new Error(`task vanished right after creation: ${id}`);
  return created;
}

export function getTask(id: string): BoardTask | null {
  const row = handle().prepare("SELECT * FROM tasks WHERE id = ?").get(id) as unknown as TaskRow | undefined;
  return row ? rowToTask(row) : null;
}

export function listTasks(filter: { status?: BoardStatus[]; assigneeBotId?: string } = {}): BoardTask[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (filter.status?.length) {
    clauses.push(`status IN (${filter.status.map(() => "?").join(", ")})`);
    params.push(...filter.status);
  }
  if (filter.assigneeBotId !== undefined) {
    clauses.push("assignee_bot_id = ?");
    params.push(filter.assigneeBotId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = handle()
    .prepare(`SELECT * FROM tasks ${where} ORDER BY priority DESC, created_at DESC`)
    .all(...params) as unknown as TaskRow[];
  return rows.map(rowToTask);
}

/** The tasks one reader may see, given who that reader can reach.
 *
 * The board is workspace-wide storage, but the fleet is not: sections and
 * per-pair allow-lists bound which bots can reach which (server/peer-roster.ts),
 * and task_create already enforces that boundary on an assignee. Reading has
 * to honour the same rule, or any bot with the board tools mounted could read
 * the titles, bodies, assignees and block reasons of every other section's
 * work. A task with no bot on either side is workspace-level — a human filed
 * it and left it unassigned — and stays visible to everyone; as soon as a bot
 * is its creator or its assignee, being able to reach that bot is the rule.
 *
 * The reachability test is injected rather than imported so this module keeps
 * knowing nothing about the roster. */
export function visibleTo(tasks: readonly BoardTask[], canReach: (botId: string) => boolean): BoardTask[] {
  return tasks.filter((task) => {
    if (!task.assigneeBotId && !task.createdByBotId) return true;
    return (task.assigneeBotId !== null && canReach(task.assigneeBotId)) ||
      (task.createdByBotId !== null && canReach(task.createdByBotId));
  });
}

export function setStatus(id: string, next: BoardStatus, patch: StatusPatch = {}): BoardTask {
  const task = getTask(id);
  if (!task) throw new Error(`no such task: ${id}`);
  if (!TRANSITIONS[task.status].includes(next)) {
    throw new Error(`illegal transition ${task.status} → ${next}`);
  }
  const now = Date.now();
  // Every claim is an attempt, including a reclaim after a dead heartbeat.
  // Without this a bot that crashes on one task retries it forever.
  const attempts = next === "running" ? task.attempts + 1 : task.attempts;
  handle()
    .prepare(`
      UPDATE tasks SET
        status = ?, attempts = ?, updated_at = ?,
        started_at   = CASE WHEN ? = 'running' THEN ? ELSE started_at END,
        heartbeat_at = CASE WHEN ? = 'running' THEN ? ELSE heartbeat_at END,
        finished_at  = CASE WHEN ? IN ('review','done') THEN ? ELSE finished_at END,
        thread_id      = COALESCE(?, thread_id),
        result         = COALESCE(?, result),
        blocked_reason = CASE WHEN ? = 'blocked' THEN ? ELSE NULL END
      WHERE id = ?
    `)
    .run(
      next,
      attempts,
      now,
      next,
      now,
      next,
      now,
      next,
      now,
      patch.threadId ?? null,
      patch.result ?? null,
      next,
      patch.blockedReason ?? null,
      id,
    );
  const updated = getTask(id);
  if (!updated) throw new Error(`task vanished during update: ${id}`);
  return updated;
}

/** The claim, as one conditional write.
 *
 * setStatus(id, "running") reads the row and then writes it, which is safe
 * for one server (the tick's own re-entrancy guard) but not for two: the
 * documented OMB2 side-by-side setup shares ~/.openmausbot, so two processes
 * ticking over one tasks.db could both read "ready" and both claim. This is
 * the same transition — and the same attempts bump, which is what makes a
 * claim an attempt — expressed as `UPDATE ... WHERE status = 'ready'`, so
 * exactly one caller can win it. Returns null when the row was not in
 * "ready" any more, i.e. somebody else got there first. */
export function claimTask(id: string): BoardTask | null {
  const now = Date.now();
  const result = handle()
    .prepare(`
      UPDATE tasks SET
        status = 'running',
        attempts = attempts + 1,
        updated_at = ?, started_at = ?, heartbeat_at = ?,
        blocked_reason = NULL
      WHERE id = ? AND status = 'ready'
    `)
    .run(now, now, now, id);
  if (Number(result.changes) !== 1) return null;
  return getTask(id);
}

/** Undo a claim that never became a turn.
 *
 * An attempt is a count of attempts STARTED — the give-up pass blocks a task
 * once it hits the cap — so a claim that provably never started anything
 * must not be charged one, or an undispatchable task (no assignee, assignee
 * busy, the wiring's startTurn threw) walks itself to "blocked" without a
 * single turn ever running. The dispatcher consults canDispatch BEFORE
 * claiming so this stays the rare path, not the normal one; it is reached
 * only when the world changed between the check and the claim.
 *
 * This weakens nothing: it is a strict inverse of claimTask, guarded on the
 * row still being "running", and the caller only reaches it when no turn
 * exists. staleRunning and the reclaim path are untouched — a task whose
 * turn DID start still spends its attempt. */
export function releaseClaim(id: string): BoardTask {
  const task = getTask(id);
  if (!task) throw new Error(`no such task: ${id}`);
  const now = Date.now();
  handle()
    .prepare(`
      UPDATE tasks SET
        status = 'ready',
        attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END,
        updated_at = ?, started_at = NULL, heartbeat_at = NULL,
        blocked_reason = NULL
      WHERE id = ? AND status = 'running'
    `)
    .run(now, id);
  // changes === 0 means the row moved on under us (a human edited it, a
  // stale sweep reclaimed it). That is not an error: there is no claim of
  // ours left to release, so report whatever the row says now.
  const updated = getTask(id);
  if (!updated) throw new Error(`task vanished during update: ${id}`);
  return updated;
}

/** Edit title, body, assignee, or priority without touching status or
 * attempts — the fields a human triages with, not the ones the state
 * machine owns. The only tri-state field is assigneeBotId: omitted leaves
 * the current assignee alone, null clears it, a string sets it. */
export function patchTask(id: string, patch: TaskPatch): BoardTask {
  const task = getTask(id);
  if (!task) throw new Error(`no such task: ${id}`);
  if (patch.budgetUsd != null && patch.budgetUsd < task.spentUsd) {
    throw new Error(`budget $${patch.budgetUsd.toFixed(3)} is below what is already spent ($${task.spentUsd.toFixed(3)})`);
  }
  const now = Date.now();
  const setAssignee = patch.assigneeBotId !== undefined;
  const setOwner = patch.owner !== undefined;
  const setDue = patch.dueAt !== undefined;
  const setBudget = patch.budgetUsd !== undefined;
  handle()
    .prepare(`
      UPDATE tasks SET
        title = COALESCE(?, title),
        body = COALESCE(?, body),
        assignee_bot_id = CASE WHEN ? THEN ? ELSE assignee_bot_id END,
        priority = COALESCE(?, priority),
        owner = CASE WHEN ? THEN ? ELSE owner END,
        due_at = CASE WHEN ? THEN ? ELSE due_at END,
        budget_usd = CASE WHEN ? THEN ? ELSE budget_usd END,
        budget_warned = CASE WHEN ? THEN 0 ELSE budget_warned END,
        updated_at = ?
      WHERE id = ?
    `)
    .run(
      patch.title === undefined ? null : clamp(patch.title, TASK_TITLE_MAX),
      patch.body === undefined ? null : clamp(patch.body, TASK_BODY_MAX),
      setAssignee ? 1 : 0,
      patch.assigneeBotId ?? null,
      patch.priority ?? null,
      setOwner ? 1 : 0,
      patch.owner ?? null,
      setDue ? 1 : 0,
      patch.dueAt ?? null,
      setBudget ? 1 : 0,
      patch.budgetUsd ?? null,
      setBudget ? 1 : 0,
      now,
      id,
    );
  let updated = getTask(id);
  if (!updated) throw new Error(`task vanished during update: ${id}`);
  // a raised (or removed) cap resumes a task that paused for money
  if (setBudget && updated.status === "blocked" && updated.blockedReason === BUDGET_PAUSED_REASON && !exhausted(updated)) {
    updated = setStatus(id, "ready");
    addComment(id, null, `Budget raised to ${updated.budgetUsd === null ? "no cap" : `$${updated.budgetUsd.toFixed(3)}`}; the task can run again.`);
  }
  return updated;
}

/** True when the task may spend nothing more: it has a cap and has reached it. */
export function exhausted(task: Pick<BoardTask, "budgetUsd" | "spentUsd">): boolean {
  return task.budgetUsd !== null && task.spentUsd >= task.budgetUsd;
}

/** Book one settled turn's cost against the task (Phase 2 part 1, decision
 * 11). A turn that reported no price books nothing and is counted. Crossing
 * the warning share posts one comment; reaching the cap pauses the task —
 * running or ready → blocked with BUDGET_PAUSED_REASON — and a task in
 * review keeps its status (the person is already deciding) but gets the
 * comment; the dispatcher never runs an exhausted task again either way. */
export function bookSpend(id: string, costUsd: number | null | undefined): { task: BoardTask; warned: boolean; paused: boolean } {
  const before = getTask(id);
  if (!before) throw new Error(`no such task: ${id}`);
  const priced = typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd > 0;
  handle()
    .prepare("UPDATE tasks SET spent_usd = spent_usd + ?, unpriced_turns = unpriced_turns + ?, updated_at = ? WHERE id = ?")
    .run(priced ? costUsd : 0, priced ? 0 : 1, Date.now(), id);
  let task = getTask(id)!;
  let warned = false;
  let paused = false;
  const cap = task.budgetUsd;
  if (cap !== null && priced) {
    const row = handle().prepare("SELECT budget_warned FROM tasks WHERE id = ?").get(id) as { budget_warned: number };
    if (exhausted(task)) {
      if (task.status === "running" || task.status === "ready") {
        task = setStatus(id, "blocked", { blockedReason: BUDGET_PAUSED_REASON });
        paused = true;
      }
      if (before.status !== "blocked") {
        addComment(id, null, `${BUDGET_PAUSED_REASON}: $${task.spentUsd.toFixed(3)} of $${cap.toFixed(3)} spent.`);
      }
    } else if (!row.budget_warned && task.spentUsd >= cap * BUDGET_WARN_SHARE) {
      handle().prepare("UPDATE tasks SET budget_warned = 1 WHERE id = ?").run(id);
      addComment(id, null, `${Math.round(BUDGET_WARN_SHARE * 100)}% of this task's budget is spent ($${task.spentUsd.toFixed(3)} of $${cap.toFixed(3)}).`);
      warned = true;
    }
  }
  return { task: getTask(id)!, warned, paused };
}

/** The task whose turn ran in this thread, newest first; null when the
 * thread is not a board task's. */
export function taskByThread(threadId: string): BoardTask | null {
  const row = handle().prepare("SELECT * FROM tasks WHERE thread_id = ? ORDER BY updated_at DESC LIMIT 1").get(threadId) as unknown as TaskRow | undefined;
  return row ? rowToTask(row) : null;
}

/** The result as the harness recorded it (the turn's digest line), without
 * touching status: what was done, not only what was said. */
export function setResult(id: string, result: string): BoardTask {
  handle().prepare("UPDATE tasks SET result = ?, updated_at = ? WHERE id = ?").run(clamp(result, TASK_BODY_MAX), Date.now(), id);
  const task = getTask(id);
  if (!task) throw new Error(`no such task: ${id}`);
  return task;
}

/** todo tasks with nothing left to wait for. An archived parent counts as
 * satisfied: abandoning a branch must not wedge everything downstream of
 * it, which is the failure mode of treating archive as "still pending". */
export function promotable(): BoardTask[] {
  const rows = handle()
    .prepare(`
      SELECT t.* FROM tasks t
      WHERE t.status = 'todo'
        AND NOT EXISTS (
          SELECT 1 FROM task_links l
          JOIN tasks p ON p.id = l.parent_id
          WHERE l.child_id = t.id AND p.status NOT IN ('done', 'archived')
        )
      ORDER BY t.priority DESC, t.created_at ASC
    `)
    .all() as unknown as TaskRow[];
  return rows.map(rowToTask);
}

/** A running task's liveness stamp. The dispatcher tick treats a running
 * task whose heartbeat has gone cold as dead and reclaims it — a bot
 * that is still alive must call this while it works, or its own task
 * gets handed back to the pool out from under it. */
export function heartbeat(id: string): BoardTask {
  const task = getTask(id);
  if (!task) throw new Error(`no such task: ${id}`);
  if (task.status !== "running") {
    throw new Error(`cannot heartbeat a task that is not running: ${task.status}`);
  }
  const now = Date.now();
  handle().prepare("UPDATE tasks SET heartbeat_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
  const updated = getTask(id);
  if (!updated) throw new Error(`task vanished during update: ${id}`);
  return updated;
}

/** Running tasks whose heartbeat has gone cold. Despite the name, this
 * takes an absolute cutoff timestamp, not a duration — the dispatcher
 * calls it as `staleRunning(now() - staleAfterMs)`, so anything with a
 * heartbeat older than that instant is presumed dead. */
export function staleRunning(olderThanMs: number): BoardTask[] {
  const rows = handle()
    .prepare(`
      SELECT * FROM tasks
      WHERE status = 'running' AND heartbeat_at IS NOT NULL AND heartbeat_at < ?
      ORDER BY priority DESC, created_at ASC
    `)
    .all(olderThanMs) as unknown as TaskRow[];
  return rows.map(rowToTask);
}

/** Record the thread a running task executed in, without moving it
 * through the status machine again. The dispatcher already claimed the
 * task via setStatus(id, "running") before it knows which thread the
 * turn landed in — calling setStatus(id, "running", ...) a second time
 * to attach it would be an illegal running -> running move, so this is
 * a dedicated writer instead of a widened TRANSITIONS table. */
export function attachThread(id: string, threadId: string): BoardTask {
  const task = getTask(id);
  if (!task) throw new Error(`no such task: ${id}`);
  const now = Date.now();
  handle().prepare("UPDATE tasks SET thread_id = ?, updated_at = ? WHERE id = ?").run(threadId, now, id);
  const updated = getTask(id);
  if (!updated) throw new Error(`task vanished during update: ${id}`);
  return updated;
}

export function linkTasks(parentId: string, childId: string): void {
  handle()
    .prepare("INSERT OR IGNORE INTO task_links (parent_id, child_id) VALUES (?, ?)")
    .run(parentId, childId);
}

export function parentsOf(id: string): BoardTask[] {
  const rows = handle()
    .prepare(`
      SELECT p.* FROM tasks p
      JOIN task_links l ON l.parent_id = p.id
      WHERE l.child_id = ?
    `)
    .all(id) as unknown as TaskRow[];
  return rows.map(rowToTask);
}

interface CommentRow {
  id: number;
  task_id: string;
  bot_id: string | null;
  text: string;
  at: number;
}

function rowToComment(row: CommentRow): BoardComment {
  return { id: row.id, taskId: row.task_id, botId: row.bot_id, text: row.text, at: row.at };
}

export function addComment(taskId: string, botId: string | null, text: string): BoardComment {
  const at = Date.now();
  const stored = clamp(text, TASK_COMMENT_MAX);
  const result = handle()
    .prepare("INSERT INTO task_comments (task_id, bot_id, text, at) VALUES (?, ?, ?, ?)")
    .run(taskId, botId, stored, at);
  return { id: Number(result.lastInsertRowid), taskId, botId, text: stored, at };
}

/** The most recent `limit` comments on one task, oldest-first. Bounded on
 * purpose: a task a bot keeps commenting on must not be able to make one
 * HTTP response grow without limit. */
export function commentsOf(taskId: string, limit: number = TASK_COMMENT_PAGE): BoardComment[] {
  const rows = handle()
    .prepare("SELECT * FROM task_comments WHERE task_id = ? ORDER BY id DESC LIMIT ?")
    .all(taskId, Math.max(1, Math.floor(limit))) as unknown as CommentRow[];
  return rows.reverse().map(rowToComment);
}
