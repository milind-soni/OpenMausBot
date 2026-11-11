import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import type { WireGroup } from "../../shared/wire.ts";
import { writeFileAtomic } from "../atomic.ts";
import { personKey } from "../person-key.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { GroupRecord } from "../store.ts";

const ROOM_READS_FILE = "room-reads.json";
const fileSchema = z.object({ version: z.literal(1), reads: z.record(z.string(), z.record(z.string(), z.string())) });

type PathMessage = { id: string; role: string; kind?: string; at?: number };

const NOT_A_REPLY = new Set(["activity", "screen", "digest", "compaction"]);
const isReply = (message: PathMessage) => message.role === "bot" && !NOT_A_REPLY.has(message.kind ?? "text");

/** Unread for a person: a bot replied after where they read up to; with no line yet, the room's own mark. A line no
 * longer on the path (an edit or a retry moved it) reads up to the last message at or before it; `atOf` gives its time. */
export function roomUnreadFor(path: readonly PathMessage[], readUpTo: string | undefined, roomUnread: boolean, atOf?: (id: string) => number | undefined): boolean {
  if (readUpTo === undefined) return roomUnread;
  let from = path.findIndex((message) => message.id === readUpTo) + 1;
  if (from === 0) {
    const readAt = atOf?.(readUpTo);
    if (readAt === undefined) return false;
    from = path.findLastIndex((message) => (message.at ?? 0) <= readAt) + 1;
  }
  return path.slice(from).some(isReply);
}

export function createRoomReads(dataDir: string) {
  const file = join(dataDir, ROOM_READS_FILE);
  let reads: Record<string, Record<string, string>> = {};
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.success) reads = parsed.data.reads;
    else console.warn(`room reads: ${file} is not a room reads file; starting fresh`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`room reads: ${file} is unreadable; starting fresh`);
  }
  const save = () => {
    try {
      writeFileAtomic(file, `${JSON.stringify({ version: 1, reads })}\n`, { mode: 0o600 });
    } catch (error) {
      console.warn(`room reads: could not save ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const key = (groupId: string, threadId?: string) => threadId ? `${groupId}/${threadId}` : groupId;
  return {
    readUpTo: (groupId: string, person: string, threadId?: string): string | undefined => reads[key(groupId, threadId)]?.[person],
    read(groupId: string, person: string, messageId: string, threadId?: string): void {
      const bucket = key(groupId, threadId);
      if (reads[bucket]?.[person] === messageId) return;
      (reads[bucket] ??= {})[person] = messageId;
      save();
    },
    forget(groupId: string, person: string, threadId?: string): void {
      const bucket = key(groupId, threadId);
      if (reads[bucket]?.[person] === undefined) return;
      delete reads[bucket]![person];
      save();
    },
    forgetRoom(groupId: string): void {
      const buckets = Object.keys(reads).filter((bucket) => bucket === groupId || bucket.startsWith(`${groupId}/`));
      if (!buckets.length) return;
      for (const bucket of buckets) delete reads[bucket];
      save();
    },
    forgetPerson(person: string): void {
      const rooms = Object.values(reads).filter((room) => room[person] !== undefined);
      if (!rooms.length) return;
      for (const room of rooms) delete room[person];
      save();
    },
  };
}

export type RoomReads = ReturnType<typeof createRoomReads>;

/** One stream frame's `group` payload as a person's own room, built once per person for that frame; null: theirs is the
 * room as it is. */
export type OwnGroupFrames = Map<string, { payload: Record<string, unknown>; frame: string } | null>;

export interface PersonRoomsDeps {
  /** Each person's own read line in each room, on a Team Cloud; null anywhere else, where a room reads the same for all. */
  reads: RoomReads | null;
  store(): { activePath(threadId: string): readonly PathMessage[]; messagesFor(threadId: string): readonly PathMessage[] };
  /** The newest message on a conversation's path, the line a room is read up to. */
  newestMessageId(threadId: string): string | undefined;
  publicGroupState(room: GroupRecord): WireGroup;
  broadcast(payload: Record<string, unknown>, options: { person: string }): void;
}

/** Each person's view of a room (server/index.ts): its unread mark and read line as they read it, on a Team Cloud. */
export function createPersonRooms(deps: PersonRoomsDeps) {
  const { reads } = deps;
  /** A room's unread mark and read line as this person has read it, on a Team Cloud; the room as it is anywhere else. */
  function groupForPerson(group: WireGroup, person: string | null): WireGroup {
    if (!reads || !person) return group;
    const currentPath = deps.store().activePath(group.threadId);
    const legacyRead = reads.readUpTo(group.id, person);
    const currentRead = reads.readUpTo(group.id, person, group.threadId)
      ?? (legacyRead && currentPath.some((message) => message.id === legacyRead) ? legacyRead : undefined);
    const tasks = group.tasks?.map((task) => {
      const path = deps.store().activePath(task.threadId);
      const readUpTo = task.threadId === group.threadId ? currentRead : reads.readUpTo(group.id, person, task.threadId);
      const unread = roomUnreadFor(path, readUpTo, task.unread ?? false,
        (id) => deps.store().messagesFor(task.threadId).find((message) => message.id === id)?.at);
      return { ...task, unread };
    });
    const unread = tasks ? tasks.some((task) => task.unread) : roomUnreadFor(currentPath, currentRead, group.unread);
    const { lastReadMessageId: _shared, ...rest } = group;
    return { ...rest, tasks, unread, ...(currentRead ? { lastReadMessageId: currentRead } : {}) };
  }
  return {
    reads,
    groupForPerson,
    groupForAuth: (auth: RequestAuth, group: WireGroup): WireGroup => groupForPerson(group, auth.kind === "session" ? personKey(auth.session) : null),
    /** A `group` frame as `person`'s own room (`frameOf` writes the stream's frame for a payload), kept in `ownGroups` for
     * the rest of that frame's streams; null when it is the room as it is. */
    ownGroupFrame(ownGroups: OwnGroupFrames, person: string, payload: Record<string, unknown>, frameOf: (payload: Record<string, unknown>) => string) {
      if (!reads || payload.kind !== "group") return null;
      if (!ownGroups.has(person)) {
        const group = payload.group as WireGroup;
        const own = groupForPerson(group, person);
        const ownPayload = { ...payload, group: own };
        ownGroups.set(person, own === group ? null : { payload: ownPayload, frame: frameOf(ownPayload) });
      }
      return ownGroups.get(person) ?? null;
    },
    /** Marks a room read or unread for the person signed in (server/routes/channels.ts `personMarkRoom`), told to their
     * streams alone; absent anywhere but a Team Cloud. */
    ...(reads ? { personMarkRoom: (auth: RequestAuth, room: GroupRecord, unread: boolean, threadId = room.threadId): WireGroup | null => {
      if (auth.kind !== "session") return null;
      const person = personKey(auth.session);
      const newest = deps.newestMessageId(threadId);
      if (unread) {
        reads.forget(room.id, person, threadId);
        if (threadId === room.threadId) reads.forget(room.id, person);
      } else if (newest) reads.read(room.id, person, newest, threadId);
      const group = deps.publicGroupState(room);
      deps.broadcast({ kind: "group", group }, { person });
      return groupForPerson(group, person);
    } } : {}),
  };
}
