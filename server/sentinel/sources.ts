// SQLite opens read-only, never `immutable`: both databases run in WAL mode and recent rows live in the -wal file,
// which immutable skips. Handles close after each short query so a scan never blocks the app's checkpoint.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { HARNESS_NOTICE, isToolIdentifier } from "./normalize.ts";
import type { SentinelRecord } from "./types.ts";

const MAX_TEXT = 2_000;
/** A log never read before is read from at most this far from its end. */
const FIRST_READ_BYTES = 8 * 1024 * 1024;

export function withReadOnlyDb<T>(file: string, read: (db: DatabaseSync) => T): T | null {
  if (!existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true, timeout: 2_000 });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

export interface ThreadOwners {
  owners: Map<string, string>;
  names: string[];
}

export function readThreadOwners(dataDir: string): ThreadOwners {
  const owners = new Map<string, string>();
  const names: string[] = [];
  let bots: unknown;
  try {
    bots = JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8"));
  } catch {
    return { owners, names };
  }
  if (!Array.isArray(bots)) return { owners, names };
  for (const bot of bots as Array<{ id?: unknown; name?: unknown; threadId?: unknown; tasks?: unknown }>) {
    if (typeof bot?.id !== "string") continue;
    if (typeof bot.name === "string" && bot.name.trim()) names.push(bot.name);
    if (typeof bot.threadId === "string") owners.set(bot.threadId, bot.id);
    if (Array.isArray(bot.tasks)) {
      for (const task of bot.tasks as Array<{ threadId?: unknown }>) {
        if (typeof task?.threadId === "string") owners.set(task.threadId, bot.id);
      }
    }
  }
  return { owners, names };
}

interface ActivityJson {
  turnId?: string;
  tool?: { name?: string; ok?: boolean; output?: string; summary?: string };
  from?: { botId?: string; name?: string };
}

/** Activity rows are UPDATEd when a tool finishes, so this rereads an `at` window instead of keeping a rowid cursor. */
export function readToolRecords(dataDir: string, sinceAt: number, who: ThreadOwners): SentinelRecord[] {
  const rows = withReadOnlyDb(join(dataDir, "messages.db"), (db) => {
    const threads = db.prepare("SELECT DISTINCT thread_id FROM messages").all() as Array<{ thread_id: string }>;
    // messages_thread_at serves each of these; json_extract keeps the
    // successful calls, nearly all of them, from crossing into JS at all.
    const failed = db.prepare(`SELECT thread_id, id, at, json FROM messages
      WHERE thread_id = ? AND at >= ? AND kind = 'activity' AND json_extract(json, '$.tool.ok') = 0`);
    return threads.flatMap(({ thread_id }) => failed.all(thread_id, sinceAt) as Array<{ thread_id: string; id: string; at: number; json: string }>);
  }) ?? [];
  rows.sort((a, b) => a.at - b.at);
  const records: SentinelRecord[] = [];
  for (const row of rows) {
    let message: ActivityJson;
    try {
      message = JSON.parse(row.json) as ActivityJson;
    } catch {
      continue;
    }
    const name = message.tool?.name ?? "";
    const notice = !isToolIdentifier(name);
    const text = notice ? withoutNames(name, who.names) : (message.tool?.output ?? message.tool?.summary ?? "");
    const botId = message.from?.botId ?? who.owners.get(row.thread_id);
    records.push({
      type: "tool", id: row.id, threadId: row.thread_id, at: Number(row.at), ok: false,
      tool: notice ? HARNESS_NOTICE : name, text: text.slice(0, MAX_TEXT),
      ...(message.turnId ? { turnId: message.turnId } : {}),
      ...(botId ? { botId } : {}),
    });
  }
  return records;
}

function withoutNames(text: string, names: string[]): string {
  let out = text;
  // longest first, so "Editor 10" is not left as "<bot>0"
  for (const name of [...names].sort((a, b) => b.length - a.length)) out = out.split(name).join("<bot>");
  return out;
}

export interface LogOffset {
  ino: number;
  offset: number;
  /** Newest createdAt already read, so a log rewritten through a rename is not read twice. */
  hwm: number;
}

export function readTurnRecords(dataDir: string, previous: Record<string, LogOffset>, who: ThreadOwners): { records: SentinelRecord[]; offsets: Record<string, LogOffset> } {
  const dir = join(dataDir, "events");
  const offsets: Record<string, LogOffset> = {};
  const records: SentinelRecord[] = [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((name) => name.endsWith(".ndjson"));
  } catch {
    return { records, offsets };
  }
  for (const name of files) {
    const read = readLogTail(join(dir, name), previous[name]);
    if (!read) continue;
    offsets[name] = read.offset;
    const threadId = name.slice(0, -".ndjson".length);
    for (const line of read.lines) {
      if (!line.includes('"turn.completed"')) continue;
      let event: { type?: string; eventId?: string; threadId?: string; turnId?: string; createdAt?: string; ok?: boolean; stopReason?: string | null; cost?: number | null };
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type !== "turn.completed" || typeof event.eventId !== "string") continue;
      const at = Date.parse(event.createdAt ?? "");
      if (!Number.isFinite(at)) continue;
      if (at <= read.skipThrough) continue;
      read.offset.hwm = Math.max(read.offset.hwm, at);
      const thread = event.threadId ?? threadId;
      const botId = who.owners.get(thread);
      records.push({
        type: "turn", id: event.eventId, threadId: thread, at, ok: event.ok !== false,
        stopReason: typeof event.stopReason === "string" ? event.stopReason : null,
        cost: typeof event.cost === "number" && Number.isFinite(event.cost) ? event.cost : null,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        ...(botId ? { botId } : {}),
      });
    }
  }
  return { records, offsets };
}

/** From the start when the file was replaced or truncated; null when it cannot be read. */
export function readLogTail(file: string, previous: LogOffset | undefined): { lines: string[]; offset: LogOffset; skipThrough: number } | null {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const { size, ino } = statSync(file);
    const continues = previous !== undefined && previous.ino === ino && previous.offset <= size;
    const start = continues ? previous.offset : previous ? 0 : Math.max(0, size - FIRST_READ_BYTES);
    // a rewritten file starts over at 0; its kept tail was read before
    const skipThrough = continues ? -Infinity : previous?.hwm ?? -Infinity;
    const offset: LogOffset = { ino, offset: start, hwm: previous?.hwm ?? 0 };
    if (size === start) return { lines: [], offset, skipThrough };
    const buffer = Buffer.allocUnsafe(size - start);
    let filled = 0;
    while (filled < buffer.length) {
      const count = readSync(fd, buffer, filled, buffer.length - filled, start + filled);
      if (count === 0) break;
      filled += count;
    }
    // only whole lines: a half-written record is read next time
    const end = buffer.lastIndexOf(0x0a, filled - 1);
    if (end === -1) return { lines: [], offset, skipThrough };
    let text = buffer.subarray(0, end + 1).toString("utf8");
    // a first read that began mid-file drops its partial first line
    if (!previous && start > 0) text = text.slice(text.indexOf("\n") + 1);
    offset.offset = start + end + 1;
    return { lines: text.split("\n").filter(Boolean), offset, skipThrough };
  } finally {
    closeSync(fd);
  }
}

/** A wait runs from `enqueued` or `resume_due` to the next `started`; one not started yet reports the time so far. */
export function readQueueRecords(dataDir: string, sinceAt: number, now: number, who: ThreadOwners): SentinelRecord[] {
  const rows = withReadOnlyDb(join(dataDir, "runtime.db"), (db) => db.prepare(`
    SELECT e.id AS eid, e.assignment_id AS aid, e.at, e.kind, a.status, a.assignee_bot_id AS bot, a.assignee_thread_id AS thread
    FROM assignment_events e JOIN assignments a ON a.id = e.assignment_id
    WHERE e.kind IN ('enqueued', 'resume_due', 'started')
      AND (a.status IN ('queued', 'resume') OR e.assignment_id IN (SELECT assignment_id FROM assignment_events WHERE at >= ?))
    ORDER BY e.assignment_id, e.id`).all(sinceAt) as Array<{ eid: number; aid: string; at: number; kind: string; status: string; bot: string; thread: string }>) ?? [];
  const records: SentinelRecord[] = [];
  const pending = (wait: (typeof rows)[number] | null) => {
    if (wait && (wait.status === "queued" || wait.status === "resume")) records.push(queueRecord(wait, now, false, who));
  };
  let waiting: (typeof rows)[number] | null = null;
  for (const row of rows) {
    if (waiting && waiting.aid !== row.aid) {
      pending(waiting);
      waiting = null;
    }
    if (row.kind !== "started") waiting = row;
    else {
      if (waiting && Number(row.at) >= sinceAt) records.push(queueRecord(waiting, Number(row.at), true, who));
      waiting = null;
    }
  }
  pending(waiting);
  return records;
}

function queueRecord(wait: { eid: number; aid: string; at: number; bot: string; thread: string }, end: number, started: boolean, who: ThreadOwners): SentinelRecord {
  const botId = wait.bot || who.owners.get(wait.thread);
  return {
    type: "queue", id: `${wait.aid}:${wait.eid}`, assignmentId: wait.aid, threadId: wait.thread, at: end, waitMs: Math.max(0, end - Number(wait.at)), started,
    ...(botId ? { botId } : {}),
  };
}
