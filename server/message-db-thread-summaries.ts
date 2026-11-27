import { ORDERING_ROW, prepared } from "./message-db.ts";
import { ROOM_THREAD_FIRST_CHARS, ROOM_THREAD_REPLIERS, type RoomThreadSpeaker, type RoomThreadSummary } from "../shared/room-threads.ts";

/** A thread's conversation lines: a person's text that no bot asked or slipped into a running turn for them, and each
 * bot turn's final answer.
 * ORDERING_ROW is repeated verbatim so SQLite can read messages_thread_order, whose partial WHERE it is. */
const IN_THREADS = "thread_id IN (SELECT value FROM json_each(?))";
const LINE_ROWS = `FROM messages INDEXED BY messages_thread_order WHERE ${IN_THREADS} AND ${ORDERING_ROW}`;
const LINES = `${LINE_ROWS} AND (role = 'bot' OR (kind = 'text' AND json_extract(json, '$.aside') IS NULL))`;
const BOT = "json_extract(json, '$.from.botId')";
const SENDER_ID = "json_extract(json, '$.sender.id')";
const SENDER_NAME = "json_extract(json, '$.sender.name')";

/** Threads an edit, Regenerate or Try again branched: only those send a person's line beside an earlier one
 * (store.branchMessage), so two of their person lines share a parent. A first line has an explicit null parent, which
 * counts as one; a row stored with no parent at all links nothing and is left out. Person lines are small, so this stays cheap. */
const PARENT = "CASE json_type(json, '$.parentId') WHEN 'null' THEN '' WHEN 'text' THEN json_extract(json, '$.parentId') END";
const BRANCHED = `SELECT thread_id AS threadId ${LINE_ROWS} AND role = 'user' AND kind = 'text' GROUP BY thread_id ` +
  `HAVING COUNT(${PARENT}) > COUNT(DISTINCT ${PARENT})`;
/** The rows on a thread's shown branch, walked from its active leaf up its parents. Each step parses a row's JSON,
 * so only branched threads take this walk. */
const ON_PATH = `WITH RECURSIVE path(thread_id, id) AS (SELECT thread_id, active_leaf_id FROM thread_state WHERE ${IN_THREADS} ` +
  "AND active_leaf_id IS NOT NULL UNION ALL SELECT m.thread_id, json_extract(m.json, '$.parentId') FROM path p " +
  "JOIN messages m ON m.thread_id = p.thread_id AND m.id = p.id WHERE json_extract(m.json, '$.parentId') IS NOT NULL)";
const PATH_ONLY = " AND id IN (SELECT path.id FROM path WHERE path.thread_id = messages.thread_id)";

/** SQLite takes the bare columns of a MIN() aggregate from the row that holds the minimum. */
const firsts = (lines: string) => `SELECT thread_id AS threadId, MIN(rowid) AS row, at, role, substr(text, 1, ${ROOM_THREAD_FIRST_CHARS + 1}) AS text, ` +
  `${BOT} AS botId, ${SENDER_ID} AS senderId, ${SENDER_NAME} AS senderName ${lines} GROUP BY thread_id`;
/** Each line's speaker is read out of its JSON once, in a materialized step, before grouping: grouping on the
 * json_extract calls themselves parses every line's JSON several times, about three times slower on long answers. */
const spoken = (lines: string) => `spoken AS MATERIALIZED (SELECT thread_id AS threadId, role, ${BOT} AS botId, ${SENDER_ID} AS senderId, ` +
  `${SENDER_NAME} AS senderName, rowid AS row, at ${lines}) SELECT threadId, role, botId, senderId, senderName, COUNT(*) AS lines, ` +
  "MAX(row) AS lastRow, MAX(at) AS lastAt FROM spoken GROUP BY threadId, role, botId, senderId, senderName";
const FIRSTS = firsts(LINES);
const SPEAKERS = `WITH ${spoken(LINES)}`;
/** The same two reads kept to the shown branch; the path's thread list is the first parameter, the lines' the second. */
const PATH_FIRSTS = `${ON_PATH} ${firsts(LINES + PATH_ONLY)}`;
const PATH_SPEAKERS = `${ON_PATH}, ${spoken(LINES + PATH_ONLY)}`;

type Who = { role: string; botId: string | null; senderId: string | null; senderName: string | null };
type FirstRow = Who & { threadId: string; row: number; at: number; text: string | null };
type SpeakerRow = Who & { threadId: string; lines: number; lastRow: number; lastAt: number };

function speakerOf(who: Who): RoomThreadSpeaker {
  if (who.role === "bot" && who.botId) return { botId: who.botId };
  return { person: { ...(who.senderId ? { id: who.senderId } : {}), ...(who.senderName ? { name: who.senderName } : {}) } };
}

const sameSpeaker = (a: Who, b: Who) => a.role === b.role && a.botId === b.botId && a.senderId === b.senderId && a.senderName === b.senderName;

/** Each listed thread's first line, how many lines came after it and from whom. Only the branch the thread shows
 * counts: a line an edit or a retry left on an older branch is not a reply. Unbranched threads, nearly all of them,
 * take two statements together; branched ones take the same two kept to their shown branch. */
export function roomThreadSummaries(threadIds: readonly string[]): RoomThreadSummary[] {
  const ids = [...new Set(threadIds.filter((id) => id.length > 0))];
  if (ids.length === 0) return [];
  const branched = new Set((prepared(BRANCHED).all(JSON.stringify(ids)) as Array<{ threadId: string }>).map((row) => row.threadId));
  const plain = JSON.stringify(ids.filter((id) => !branched.has(id)));
  const onPath = JSON.stringify([...branched]);
  const firstRows = prepared(FIRSTS).all(plain) as FirstRow[];
  const speakerRows = prepared(SPEAKERS).all(plain) as SpeakerRow[];
  if (branched.size > 0) {
    firstRows.push(...(prepared(PATH_FIRSTS).all(onPath, onPath) as FirstRow[]));
    speakerRows.push(...(prepared(PATH_SPEAKERS).all(onPath, onPath) as SpeakerRow[]));
  }
  const firsts = new Map(firstRows.map((row) => [row.threadId, row]));
  const speakers = new Map<string, SpeakerRow[]>();
  for (const row of speakerRows) speakers.set(row.threadId, [...(speakers.get(row.threadId) ?? []), row]);
  return ids.map((threadId) => {
    const first = firsts.get(threadId);
    if (!first) return { threadId, first: null, replies: 0, lastReplyAt: null, repliers: [] };
    const after = (speakers.get(threadId) ?? []).flatMap((row) => {
      const lines = sameSpeaker(row, first) ? Number(row.lines) - 1 : Number(row.lines);
      return lines > 0 ? [{ ...row, lines }] : [];
    }).sort((a, b) => Number(b.lastRow) - Number(a.lastRow));
    const text = first.text ?? "";
    return {
      threadId,
      first: { text: text.slice(0, ROOM_THREAD_FIRST_CHARS), ...(text.length > ROOM_THREAD_FIRST_CHARS ? { clipped: true as const } : {}), speaker: speakerOf(first), at: Number(first.at) },
      replies: after.reduce((sum, row) => sum + row.lines, 0),
      lastReplyAt: after.length > 0 ? Math.max(...after.map((row) => Number(row.lastAt))) : null,
      repliers: after.slice(0, ROOM_THREAD_REPLIERS).map(speakerOf),
    };
  });
}
