// Phase 3 part 4 — the graph runner.
//
// Unattended work as a fixed list of nodes with a checkpoint per node in
// SQLite. The first graph is a routine run: intake → work → check → judge
// → ship. The routine's instructions stay the source; the graph is derived
// from them and never a second truth. A crash resumes at the first
// unfinished node, and a finished node's output is reused instead of
// recomputed — which is what lets a harness test replay a recorded run
// with zero model calls.
//
// This module owns storage and the node machine only. What each node does
// (start a turn, run gates, ask the verifier) lives with the caller.
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "./config.ts";

export type NodeKind = "bot_turn" | "decision" | "code" | "check" | "approval" | "verify";
export type NodeStatus = "pending" | "running" | "done" | "failed" | "skipped";
export type GraphStatus = "running" | "completed" | "failed";

export interface GraphNode {
  name: string;
  kind: NodeKind;
  position: number;
  status: NodeStatus;
  output: unknown;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface GraphRun {
  id: string;
  /** What kind of thing this graph runs: "routine" first. */
  kind: string;
  /** The id of that thing: the routine run's id. */
  subjectId: string;
  status: GraphStatus;
  createdAt: number;
  updatedAt: number;
  nodes: GraphNode[];
}

let db: DatabaseSync | null = null;
let file = "";

export function graphsFile(): string {
  return file;
}

function handle(): DatabaseSync {
  if (!db) openGraphs();
  return db!;
}

export function openGraphs(path: string = join(DATA_DIR, "graphs.db")): void {
  db?.close();
  mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  file = path;
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS graph_runs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS graph_runs_subject ON graph_runs (kind, subject_id);
    CREATE TABLE IF NOT EXISTS graph_nodes (
      run_id TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      position INTEGER NOT NULL,
      status TEXT NOT NULL,
      output_json TEXT,
      error TEXT,
      started_at INTEGER,
      finished_at INTEGER,
      PRIMARY KEY (run_id, name)
    );
  `);
}

interface RunRow { id: string; kind: string; subject_id: string; status: GraphStatus; created_at: number; updated_at: number }
interface NodeRow { run_id: string; name: string; kind: NodeKind; position: number; status: NodeStatus; output_json: string | null; error: string | null; started_at: number | null; finished_at: number | null }

function nodesOf(runId: string): GraphNode[] {
  const rows = handle().prepare("SELECT * FROM graph_nodes WHERE run_id = ? ORDER BY position").all(runId) as unknown as NodeRow[];
  return rows.map((row) => ({
    name: row.name,
    kind: row.kind,
    position: row.position,
    status: row.status,
    output: row.output_json ? JSON.parse(row.output_json) : null,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }));
}

function rowToRun(row: RunRow): GraphRun {
  return { id: row.id, kind: row.kind, subjectId: row.subject_id, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, nodes: nodesOf(row.id) };
}

export function getGraphRun(id: string): GraphRun | null {
  const row = handle().prepare("SELECT * FROM graph_runs WHERE id = ?").get(id) as unknown as RunRow | undefined;
  return row ? rowToRun(row) : null;
}

export function bySubject(kind: string, subjectId: string): GraphRun | null {
  const row = handle().prepare("SELECT * FROM graph_runs WHERE kind = ? AND subject_id = ? ORDER BY created_at DESC LIMIT 1").get(kind, subjectId) as unknown as RunRow | undefined;
  return row ? rowToRun(row) : null;
}

export function startGraphRun(input: { kind: string; subjectId: string; nodes: ReadonlyArray<{ name: string; kind: NodeKind }> }): GraphRun {
  const id = randomUUID();
  const now = Date.now();
  const d = handle();
  d.prepare("INSERT INTO graph_runs (id, kind, subject_id, status, created_at, updated_at) VALUES (?, ?, ?, 'running', ?, ?)").run(id, input.kind, input.subjectId, now, now);
  const insert = d.prepare("INSERT INTO graph_nodes (run_id, name, kind, position, status) VALUES (?, ?, ?, ?, 'pending')");
  input.nodes.forEach((node, position) => insert.run(id, node.name, node.kind, position));
  return getGraphRun(id)!;
}

function touch(runId: string, status?: GraphStatus): void {
  if (status) handle().prepare("UPDATE graph_runs SET status = ?, updated_at = ? WHERE id = ?").run(status, Date.now(), runId);
  else handle().prepare("UPDATE graph_runs SET updated_at = ? WHERE id = ?").run(Date.now(), runId);
}

export function beginNode(runId: string, name: string): void {
  handle().prepare("UPDATE graph_nodes SET status = 'running', started_at = ?, error = NULL WHERE run_id = ? AND name = ?").run(Date.now(), runId, name);
  touch(runId);
}

/** Checkpoint: the node's output is what a resume reuses. Finishing the last
 * node completes the run. */
export function finishNode(runId: string, name: string, output: unknown): void {
  const now = Date.now();
  handle().prepare("UPDATE graph_nodes SET status = 'done', output_json = ?, finished_at = ?, started_at = COALESCE(started_at, ?), error = NULL WHERE run_id = ? AND name = ?")
    .run(JSON.stringify(output ?? null), now, now, runId, name);
  touch(runId, nextPending(runId) ? undefined : "completed");
}

export function failNode(runId: string, name: string, error: string): void {
  const now = Date.now();
  handle().prepare("UPDATE graph_nodes SET status = 'failed', error = ?, finished_at = ?, started_at = COALESCE(started_at, ?) WHERE run_id = ? AND name = ?").run(error.slice(0, 2_000), now, now, runId, name);
  touch(runId, "failed");
}

export function skipNode(runId: string, name: string, why: string): void {
  handle().prepare("UPDATE graph_nodes SET status = 'skipped', error = ?, finished_at = ? WHERE run_id = ? AND name = ?").run(why.slice(0, 500), Date.now(), runId, name);
  touch(runId, nextPending(runId) ? undefined : "completed");
}

export function nextPending(runId: string): GraphNode | null {
  return nodesOf(runId).find((node) => node.status === "pending" || node.status === "running") ?? null;
}

export function nodeOutput(runId: string, name: string): unknown {
  const node = nodesOf(runId).find((n) => n.name === name);
  return node && node.status === "done" ? node.output : null;
}

/** Runs a restart can pick up: still running, the bot's turn already done
 * (its output is a checkpoint), a later node pending or interrupted. A run
 * that died inside its bot turn is not resumable — that turn is gone. */
export function resumable(kind: string): GraphRun[] {
  const rows = handle().prepare("SELECT * FROM graph_runs WHERE kind = ? AND status = 'running' ORDER BY created_at").all(kind) as unknown as RunRow[];
  return rows.map(rowToRun).filter((run) => {
    const turns = run.nodes.filter((n) => n.kind === "bot_turn");
    if (!turns.length || turns.some((n) => n.status !== "done")) return false;
    return run.nodes.some((n) => n.status === "pending" || n.status === "running");
  });
}

/** Before resuming: a node that was running when the process died runs again. */
export function resetRunningNodes(runId: string): void {
  handle().prepare("UPDATE graph_nodes SET status = 'pending', started_at = NULL WHERE run_id = ? AND status = 'running'").run(runId);
  touch(runId);
}
