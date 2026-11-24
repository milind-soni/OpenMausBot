import { ORDERING_ROW, prepared } from "./message-db.ts";
import { ROOM_THREAD_FIRST_CHARS, ROOM_THREAD_REPLIERS, type RoomThreadSpeaker, type RoomThreadSummary } from "../shared/room-threads.ts";

/** A thread's conversation lines: a person's text that no bot asked or slipped into a running turn for them, and each
 * bot turn's final answer.
 * ORDERING_ROW is repeated verbatim so SQLite can read messages_thread_order, whose partial WHERE it is. */
const LINES = `FROM messages INDEXED BY messages_thread_order WHERE thread_id IN (SELECT value FROM json_each(?)) AND ${ORDERING_ROW} AND (role = 'bot' OR (kind = 'text' AND json_extract(json, '$.aside') IS NULL))`;
const BOT = "json_extract(json, '$.from.botId')";
const SENDER_ID = "json_extract(json, '$.sender.id')";
const SENDER_NAME = "json_extract(json, '$.sender.name')";

/** SQLite takes the bare columns of a MIN() aggregate from the row that holds the minimum. */
const FIRSTS = `SELECT thread_id AS threadId, MIN(rowid) AS row, at, role, substr(text, 1, ${ROOM_THREAD_FIRST_CHARS + 1}) AS text, ` +
  `${BOT} AS botId, ${SENDER_ID} AS senderId, ${SENDER_NAME} AS senderName ${LINES} GROUP BY thread_id`;
const SPEAKERS = `SELECT thread_id AS threadId, role, ${BOT} AS botId, ${SENDER_ID} AS senderId, ${SENDER_NAME} AS senderName, ` +
  `COUNT(*) AS lines, MAX(rowid) AS lastRow, MAX(at) AS lastAt ${LINES} GROUP BY thread_id, role, botId, senderId, senderName`;

type Who = { role: string; botId: string | null; senderId: string | null; senderName: string | null };
type FirstRow = Who & { threadId: string; row: number; at: number; text: string | null };
type SpeakerRow = Who & { threadId: string; lines: number; lastRow: number; lastAt: number };

function speakerOf(who: Who): RoomThreadSpeaker {
  if (who.role === "bot" && who.botId) return { botId: who.botId };
  return { person: { ...(who.senderId ? { id: who.senderId } : {}), ...(who.senderName ? { name: who.senderName } : {}) } };
}

const sameSpeaker = (a: Who, b: Who) => a.role === b.role && a.botId === b.botId && a.senderId === b.senderId && a.senderName === b.senderName;

/** Each listed thread's first line, how many lines came after it and from whom, in two statements for all of them.
 * Every branch of a thread counts: a line an edit or a retry left on an older branch is still counted as a reply. */
export function roomThreadSummaries(threadIds: readonly string[]): RoomThreadSummary[] {
  const ids = [...new Set(threadIds.filter((id) => id.length > 0))];
  if (ids.length === 0) return [];
  const list = JSON.stringify(ids);
  const firsts = new Map((prepared(FIRSTS).all(list) as FirstRow[]).map((row) => [row.threadId, row]));
  const speakers = new Map<string, SpeakerRow[]>();
  for (const row of prepared(SPEAKERS).all(list) as SpeakerRow[]) speakers.set(row.threadId, [...(speakers.get(row.threadId) ?? []), row]);
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
