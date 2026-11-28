import { prepared } from "./message-db.ts";
import type { Message } from "./store.ts";

const STARTED_AT = "COALESCE(json_extract(json, '$.goalRun.startedAt'), at)";
const THREAD_GOALS = "FROM messages INDEXED BY messages_thread_goals WHERE thread_id = ? AND kind = 'goal.run'";
const ORDER = `ORDER BY ${STARTED_AT} DESC, at DESC, id DESC LIMIT ?`;

export const GOAL_MESSAGE_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS messages_thread_goals ON messages(thread_id, ${STARTED_AT}, at, id) WHERE kind = 'goal.run';
  CREATE INDEX IF NOT EXISTS messages_goal_run ON messages(at) WHERE kind = 'goal.run';`;

export function threadGoalPage(threadId: string, limit: number, before: string | null): { messages: Message[]; nextBefore: string | null } | null {
  let rows: Array<{ json: string }>;
  if (before === null) {
    rows = prepared(`SELECT json ${THREAD_GOALS} ${ORDER}`).all(threadId, limit + 1) as typeof rows;
  } else {
    const pivot = prepared(
      `SELECT ${STARTED_AT} AS startedAt, at FROM messages WHERE thread_id = ? AND id = ? AND kind = 'goal.run'`,
    ).get(threadId, before) as { startedAt: number; at: number } | undefined;
    if (!pivot) return null;
    // SQLite can seek by the scalar expression bound even when it leaves the tuple comparison as a filter.
    rows = prepared(`SELECT json ${THREAD_GOALS} AND ${STARTED_AT} <= ? AND (${STARTED_AT}, at, id) < (?, ?, ?) ${ORDER}`)
      .all(threadId, pivot.startedAt, pivot.startedAt, pivot.at, before, limit + 1) as typeof rows;
  }
  const messages = rows.slice(0, limit).map((row) => JSON.parse(row.json) as Message);
  return { messages, nextBefore: rows.length > limit ? messages.at(-1)!.id : null };
}

export function workingGoalRunMessages(): Array<{ threadId: string; message: Message }> {
  const rows = prepared(
    "SELECT thread_id, json FROM messages WHERE kind = 'goal.run' AND json_extract(json, '$.goalRun.status') = 'working'",
  ).all() as Array<{ thread_id: string; json: string }>;
  return rows.map((row) => ({ threadId: row.thread_id, message: JSON.parse(row.json) as Message }));
}
