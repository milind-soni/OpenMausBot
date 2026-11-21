// What a move reads of conversations without parsing every stored row or keeping it parsed in memory: a conversation's
// row ids and parents straight from messages.db, only the rows that can name an attachment, and only the rows asked for
// by id. A Cloud with thousands of conversations answers a move's check in bounded time and memory this way.
import { attachmentNames } from "./cloud-chat-merge.ts";
import { prepared } from "./message-db.ts";
import type { Message } from "./store.ts";

/** A conversation's rows, oldest first, each with its parent, and its active leaf. */
export interface ThreadLinks { ids: string[]; parent: Map<string, string | null>; leaf: string | null }

const BY_ID_CHUNK = 200;
/** Up to this many conversations are read one by one, by their index, rather than by reading every row. */
const BY_THREAD_MAX = 500;

/** As the store reads a conversation: a row stored without a parent follows the row before it, and the active leaf is
 * the newest row when none was kept. Null when messages.db holds no row of it. */
export function threadLinks(threadId: string): ThreadLinks | null {
  const rows = prepared("SELECT id, json_type(json, '$.parentId') AS type, json_extract(json, '$.parentId') AS parent FROM messages WHERE thread_id = ? ORDER BY rowid")
    .all(threadId) as Array<{ id: string; type: string | null; parent: unknown }>;
  if (!rows.length) return null;
  const ids: string[] = [], parent = new Map<string, string | null>();
  let previous: string | null = null;
  for (const row of rows) {
    ids.push(row.id);
    parent.set(row.id, row.type === null ? previous : typeof row.parent === "string" ? row.parent : null);
    previous = row.id;
  }
  const state = prepared("SELECT active_leaf_id FROM thread_state WHERE thread_id = ?").get(threadId) as { active_leaf_id: string | null } | undefined;
  return { ids, parent, leaf: state?.active_leaf_id || ids.at(-1) || null };
}

/** Each conversation's kept active leaf, without reading any of its rows. */
export function activeLeaves(): Map<string, string> {
  const rows = prepared("SELECT thread_id AS threadId, active_leaf_id AS leaf FROM thread_state WHERE active_leaf_id IS NOT NULL").all() as Array<{ threadId: string; leaf: string }>;
  return new Map(rows.map((row) => [row.threadId, row.leaf]));
}

/** The links of rows the store already holds parsed. */
export function linksOf(rows: readonly Message[], leaf: string | null): ThreadLinks {
  return { ids: rows.map((row) => row.id), parent: new Map(rows.map((row) => [row.id, row.parentId ?? null])), leaf };
}

/** The ids on the path from the root to the leaf. */
export function linkedPath(links: ThreadLinks): string[] {
  const path: string[] = [], seen = new Set<string>();
  for (let id = links.leaf; id !== null && links.parent.has(id) && !seen.has(id); id = links.parent.get(id) ?? null) {
    seen.add(id);
    path.push(id);
  }
  return path.reverse();
}

/** The stored rows of a conversation with these ids; `owners`: only those a person wrote or that carry a card. */
export function storedRows(threadId: string, ids: readonly string[], { owners = false } = {}): Message[] {
  const out: Message[] = [];
  const sql = `SELECT json FROM messages WHERE thread_id = ? AND id IN (${Array(BY_ID_CHUNK).fill("?").join(",")})${owners ? " AND (role = 'user' OR instr(json, '\"card\"') > 0)" : ""}`;
  for (let at = 0; at < ids.length; at += BY_ID_CHUNK) {
    const chunk = ids.slice(at, at + BY_ID_CHUNK);
    const padded = chunk.length < BY_ID_CHUNK ? [...chunk, ...Array<string>(BY_ID_CHUNK - chunk.length).fill("")] : chunk;
    for (const row of prepared(sql).all(threadId, ...padded) as Array<{ json: string }>) out.push(JSON.parse(row.json) as Message);
  }
  return out;
}

/** Each stored attachment the rows of these conversations name. Only a row whose stored JSON mentions an attachment is
 * parsed, one at a time. */
export function attachmentNamesOf(threadIds: ReadonlySet<string>, dataDir: string): Set<string> {
  const names = new Set<string>();
  const add = (rows: Iterable<unknown>) => {
    for (const row of rows as Iterable<{ threadId: string; json: string }>) {
      if (!threadIds.has(row.threadId)) continue;
      for (const name of attachmentNames(JSON.parse(row.json) as Message, dataDir)) names.add(name);
    }
  };
  const naming = "(instr(json, 'attachments') > 0 OR instr(json, '<attached-') > 0)";
  if (threadIds.size > BY_THREAD_MAX) add(prepared(`SELECT thread_id AS threadId, json FROM messages WHERE ${naming}`).iterate());
  else for (const threadId of threadIds) add(prepared(`SELECT thread_id AS threadId, json FROM messages WHERE thread_id = ? AND ${naming}`).iterate(threadId));
  return names;
}
