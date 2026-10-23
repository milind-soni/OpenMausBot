// Send to My Cloud's chats, by row, never as a copy. This computer lists each bot conversation's newest stored
// row (GET /api/cloud-send/chats) and hands main the rows stored after the last one My Cloud took (GET
// /api/cloud-send/chats/rows); My Cloud adds them as Bring newer chats adds a copy's (cloud-chat-merge.ts): only what it
// lacks, never replacing or deleting anything. A conversation's history therefore goes once, and then only what is new.
// Admin scope (request-auth's default) on both sides.
import { lstat, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import type { ApprovalMode } from "../shared/approval-mode.ts";
import type { BotVisibility, ModelSelection } from "../shared/wire.ts";
import { ATTACHMENTS_DIR, FILE_MAX_BYTES, saveNamedAttachment } from "./attachments.ts";
import { audienceEquals, narrowestAudience } from "./bot-visibility.ts";
import { activePath, addSentChats, attachmentNames, ATTACHMENT_NAME, type ChatStore, type SentConversation, type SentRoom } from "./cloud-chat-merge.ts";
import { threadHeads, threadRowNumbers, threadRowsFrom } from "./message-db.ts";
import { ownerStamp, unstamped, type CloudOwner } from "./cloud-owner-lines.ts";
import type { RequestAuth } from "./request-auth.ts";
import type { RouteContext } from "./routes/table.ts";
import type { BotRecord, GroupRecord, GroupTaskRecord, Message, Store, TaskPatch, TaskRecord } from "./store.ts";

export const CHAT_ROWS_PAGE = 300;
/** A page's rows past its first, by their stored size: main sends a few pages per request, under CHATS_BODY_MAX. */
export const CHAT_PAGE_BYTES = 2 * 1024 * 1024;
/** A request may hold one row of any size the app keeps: rows always go whole. */
export const CHATS_BODY_MAX = 64 * 1024 * 1024;
/** A check of a move's chats asks about at most this many row ids of a conversation, and of its path, at a time. */
export const VERIFY_IDS = 5_000;
const PREFIX = "/api/cloud-send/chats";
const ROOM_NAME_MAX = 100, ROOM_MEMBERS_MAX = 200, ROOM_BULLETIN_MAX = 12_000;

/** A bot's conversation (`bot`) or a room's (`room`). */
export type ChatHead = ({ bot: string; room?: never } | { room: string; bot?: never }) & { threadId: string; last: number; lastId: string; busy: boolean };
type Room = Pick<GroupRecord, "id" | "threadId" | "tasks" | "dm" | "busyBotId" | "memberIds">;

/** A room's conversations: its threads, or its one conversation when it has none. Bot-to-bot channels are not rooms. */
const roomThreads = (room: Room): string[] => room.dm ? [] : room.tasks?.length ? room.tasks.map((task) => task.threadId) : [room.threadId];

/** Every bot and room conversation with stored rows: its newest row, and whether a bot is answering in it now. */
export function chatHeads(bots: readonly BotRecord[], rooms: readonly Room[] = [], heads = threadHeads()): ChatHead[] {
  const out: ChatHead[] = [];
  const seen = new Set<string>();
  const add = (owner: { bot: string } | { room: string }, threadId: string, busy: boolean) => {
    const head = heads.get(threadId);
    if (!head || seen.has(threadId)) return;
    seen.add(threadId);
    out.push({ ...owner, threadId, last: head.last, lastId: head.lastId, busy });
  };
  for (const bot of bots) {
    add({ bot: bot.id }, bot.threadId, Boolean(bot.busy));
    for (const task of bot.tasks ?? []) add({ bot: bot.id }, task.threadId, Boolean(task.busy));
  }
  for (const room of rooms) for (const threadId of roomThreads(room)) add({ room: room.id }, threadId, Boolean(room.busyBotId));
  return out;
}

/** The rooms none of whose conversations has a stored row yet (a team setup's or a package's, say), with their members:
 * chatHeads lists none of them, and My Cloud makes a room only from a conversation of it, so each goes as its active
 * thread with no rows. */
export function emptyRooms(rooms: readonly Room[], heads: readonly ChatHead[]): Array<{ room: string; threadId: string; members: string[] }> {
  const listed = new Set(heads.map((head) => head.threadId));
  return rooms.filter((room) => !room.dm && roomThreads(room).every((threadId) => !listed.has(threadId)))
    .map((room) => ({ room: room.id, threadId: room.threadId, members: [...room.memberIds] }));
}

/**
 * A conversation's rows stored after `after`, oldest first. `after` counts only while its row is still `afterId`: a
 * deleted row's number can be given out again, so otherwise the conversation starts over (`restarted`), which adding by
 * id makes harmless. A legacy row without a parent takes the row before it.
 *
 * `path` is the conversation's active path, root first. A page never ends between a row of it and a row above it on it,
 * which an inserted row can be stored after, and `leaf` is the deepest row of it whose rows up from the root all are at or
 * before the page's end: where the conversation stands for whoever has every page up to this one.
 */
export function threadRowsAfter(threadId: string, after: number, afterId: string | null, limit: number, maxBytes = Number.POSITIVE_INFINITY, path: readonly string[] = []):
  { rows: Message[]; leaf: string | null; last: number; lastId: string | null; more: boolean; restarted: boolean } {
  const numbers = threadRowNumbers(threadId);
  const held = after > 0 && afterId !== null && numbers.get(afterId) === after;
  const from = held ? after : 0;
  let found = threadRowsFrom(threadId, from, { limit: limit + 1 });
  // A page holds at most `limit` rows and, past its first row, at most `maxBytes` of them.
  let kept = 0, bytes = 0;
  while (kept < Math.min(found.length, limit) && (kept === 0 || bytes + found[kept]!.bytes <= maxBytes)) bytes += found[kept++]!.bytes;
  // The path's rows, each with the highest number among it and the path rows above it.
  const onPath: Array<{ id: string; at: number; highest: number }> = [];
  for (const id of path) {
    const at = numbers.get(id);
    if (at === undefined) break;
    onPath.push({ id, at, highest: Math.max(onPath.at(-1)?.highest ?? 0, at) });
  }
  const highest = new Map(onPath.map((row) => [row.at, row.highest]));
  const reach = (rows: ReadonlyArray<{ at: number }>) => rows.reduce((most, row) => Math.max(most, highest.get(row.at) ?? 0), 0);
  let count = kept;
  while (count > 0 && reach(found.slice(0, count)) > found[count - 1]!.at) count--;
  if (!count && kept) {
    for (let end = reach(found.slice(0, 1)); ;) {
      found = threadRowsFrom(threadId, from, { through: end });
      if (reach(found) > end) { end = reach(found); continue; }
      count = found.length;
      found.push(...threadRowsFrom(threadId, end, { limit: 1 }));
      break;
    }
  }
  const more = found.length > count;
  found.length = count;
  let previous: string | null = null, previousAt = 0;
  if (from) for (const [id, at] of numbers) if (at <= from && at > previousAt) { previous = id; previousAt = at; }
  const rows = found.map(({ message }) => {
    if (message.parentId === undefined) message.parentId = previous;
    previous = message.id;
    return message;
  });
  const end = found.at(-1)?.at ?? from;
  let leaf: string | null = null;
  for (const row of onPath) { if (row.highest > end) break; leaf = row.id; }
  return { rows, leaf, last: end, lastId: found.at(-1)?.message.id ?? (held ? afterId : null), more, restarted: after > 0 && !held };
}

const taskOf = (bot: BotRecord, threadId: string): TaskRecord | null => (bot.tasks ?? []).find((task) => task.threadId === threadId) ?? null;
/** What a task carries to My Cloud: never this computer's turn state. */
function sentTask(task: TaskRecord): TaskRecord {
  const { busy: _busy, activity: _activity, turnStartedAt: _started, resumeCursors: _cursors, ...kept } = task as TaskRecord & Record<string, unknown>;
  return kept as unknown as TaskRecord;
}
const pick = <T extends object>(source: T, keys: readonly string[]) => Object.fromEntries(keys.filter((key) => (source as Record<string, unknown>)[key] !== undefined)
  .map((key) => [key, (source as Record<string, unknown>)[key]]));
/** What a room's thread carries to My Cloud: never this computer's folders. */
const sentRoomTask = (task: GroupTaskRecord) => pick(task, ["threadId", "title", "createdAt", "titleFromFirstMessage", "pinned", "pinnedMessageId", "turnTimeoutMinutes"]) as unknown as GroupTaskRecord;
/** As My Cloud takes a room (sentSchema): a calendar call's room keeps the call's name, which may be longer, and one room it
 * refuses refuses every conversation sent beside it. */
const sentRoom = (room: GroupRecord) => ({ ...pick(room, ["defaultResponder", "section", "setupCompletedAt", "setupSkippedAt", "audienceFloor"]),
  name: room.name.slice(0, ROOM_NAME_MAX) || "Room", memberIds: room.memberIds.slice(0, ROOM_MEMBERS_MAX), bulletin: (room.bulletin ?? "").slice(0, ROOM_BULLETIN_MAX) }) as unknown as SentRoom;

/** A conversation's own settings a move carries: its model, approval, snooze and project; a room conversation's time
 * limit and its room's audience floor. Custom approval never leaves the computer that granted it. */
const BOT_SETTINGS = ["modelSelection", "approvalMode", "autoApprove", "snoozedUntil", "projectId"] as const;
export function conversationSettings(store: Pick<ChatStore, "bot" | "group">, head: Pick<ChatHead, "bot" | "room" | "threadId">): Record<string, unknown> {
  if (head.bot) {
    const bot = store.bot(head.bot);
    const task = bot ? taskOf(bot, head.threadId) : null;
    const out = task ? pick(task, BOT_SETTINGS) : {};
    if (out.approvalMode === "custom") { delete out.approvalMode; delete out.autoApprove; }
    return out;
  }
  const room = store.group(head.room!);
  const task = room?.tasks?.find((candidate) => candidate.threadId === head.threadId);
  return { ...(task?.turnTimeoutMinutes !== undefined ? { turnTimeoutMinutes: task.turnTimeoutMinutes } : {}), ...(room?.audienceFloor ? { audienceFloor: room.audienceFloor } : {}) };
}

/** Each stored attachment the conversations' rows name, with its size. */
async function attachmentSizes(store: ChatStore, dataDir: string, heads: readonly ChatHead[]): Promise<Array<{ name: string; size: number }>> {
  const names = new Set<string>();
  for (const head of heads) for (const row of store.messagesFor(head.threadId)) for (const name of attachmentNames(row, dataDir)) names.add(name);
  const out: Array<{ name: string; size: number }> = [];
  for (const name of names) {
    const info = await lstat(join(ATTACHMENTS_DIR, name)).catch(() => null);
    if (info?.isFile()) out.push({ name, size: info.size });
  }
  return out;
}

const settingsSchema = z.object({
  v: z.literal(1),
  conversations: z.array(z.object({ threadId: z.string().regex(/^[\w-]{1,200}$/u), settings: z.object({
    modelSelection: z.object({ instanceId: z.string().max(128), model: z.string().max(500) }).passthrough().optional(),
    approvalMode: z.enum(["ask", "edits", "auto", "full"]).optional(),
    autoApprove: z.boolean().optional(),
    snoozedUntil: z.number().finite().min(0).optional(),
    projectId: z.string().max(128).optional(),
    turnTimeoutMinutes: z.number().int().min(1).max(24 * 60).optional(),
    audienceFloor: z.unknown().optional(),
  }) })).max(500),
});

/** A setting My Cloud's copy of a conversation lacks takes this computer's; one it has stays its own. The audience floor
 * only ever narrows. How many conversations changed. */
export function adoptConversationSettings(store: CloudSendChatsDeps["store"], conversations: z.infer<typeof settingsSchema>["conversations"],
  allowed: { instance(id: string): boolean; approval(selection: ModelSelection, mode: ApprovalMode): boolean }): number {
  let changed = 0;
  for (const { threadId, settings } of conversations) {
    const { bot, room } = ownerOf(store, threadId);
    if (bot) {
      const task = store.taskByThread(bot.id, threadId);
      if (!task) continue;
      const patch: TaskPatch = {};
      if (task.modelSelection === undefined && settings.modelSelection && allowed.instance(settings.modelSelection.instanceId)) patch.modelSelection = settings.modelSelection as ModelSelection;
      const selection = patch.modelSelection ?? task.modelSelection ?? bot.modelSelection;
      if (task.approvalMode === undefined && settings.approvalMode && allowed.approval(selection, settings.approvalMode)) {
        patch.approvalMode = settings.approvalMode;
        patch.autoApprove = settings.approvalMode === "auto";
      }
      if (task.snoozedUntil === undefined && settings.snoozedUntil !== undefined) patch.snoozedUntil = settings.snoozedUntil;
      if (task.projectId === undefined && settings.projectId && bot.projects?.some((project) => project.id === settings.projectId)) patch.projectId = settings.projectId;
      if (Object.keys(patch).length && store.patchTask(bot.id, threadId, patch)) changed++;
      continue;
    }
    if (!room) continue;
    let touched = false;
    const task = room.tasks?.find((candidate) => candidate.threadId === threadId);
    if (task && task.turnTimeoutMinutes === undefined && settings.turnTimeoutMinutes !== undefined) touched = Boolean(store.patchGroupTask(room.id, threadId, { turnTimeoutMinutes: settings.turnTimeoutMinutes })) || touched;
    if (settings.audienceFloor !== undefined) {
      const floor = narrowestAudience([room.audienceFloor, settings.audienceFloor]);
      if (!audienceEquals(floor, room.audienceFloor ?? "everyone")) touched = Boolean(store.patchGroup(room.id, { audienceFloor: floor === "everyone" ? undefined : floor as BotVisibility })) || touched;
    }
    if (touched) changed++;
  }
  return changed;
}

const messageSchema = z.object({ id: z.string().min(1).max(200), at: z.number().finite() }).passthrough();
const sentSchema = z.object({
  v: z.literal(1),
  dataDir: z.string().min(1).max(4096),
  conversations: z.array(z.object({
    bot: z.string().regex(/^[\w-]{1,128}$/u).optional(),
    room: z.string().regex(/^[\w-]{1,128}$/u).optional(),
    roomInfo: z.object({ name: z.string().min(1).max(ROOM_NAME_MAX), memberIds: z.array(z.string().max(128)).max(ROOM_MEMBERS_MAX), bulletin: z.string().max(ROOM_BULLETIN_MAX) }).passthrough().optional(),
    threadId: z.string().regex(/^[\w-]{1,200}$/u),
    task: z.object({ threadId: z.string(), createdAt: z.number().finite() }).passthrough().nullable(),
    rows: z.array(messageSchema).max(CHAT_ROWS_PAGE * 4),
    leaf: z.string().max(200).nullable(),
    sent: z.boolean(),
  }).refine((entry) => (entry.bot === undefined) !== (entry.room === undefined))).max(200),
});

export interface CloudSendChatsDeps {
  store: ChatStore & Pick<Store, "patchMessage" | "taskByThread" | "patchTask" | "patchGroupTask"> & { bots: BotRecord[] };
  dataDir: string;
  /** My Cloud's owner, when the request is the owner's own session on a Cloud home; null otherwise. */
  owner?(auth: RequestAuth): CloudOwner | null;
  /** Lines of a conversation it held became its owner's: whatever remembers who wrote in it looks again. */
  stamped?(threadId: string): void;
  /** A model this server runs, and an approval level it lets a conversation on that model have. */
  instanceExists?(id: string): boolean;
  approvalSupported?(selection: ModelSelection, mode: ApprovalMode): boolean;
  /** A move of this one bot into a team: its conversations only. */
  bot?: string;
  /** This Cloud's owner's person key, as their lines here carry it: a bot moving into a team tells the team whose lines
   * become the mover's. */
  ownerKey?: string;
}

const ownerOf = (store: Pick<ChatStore, "bots" | "groups">, threadId: string) => {
  const bot = store.bots.find((candidate) => candidate.threadId === threadId || (candidate.tasks ?? []).some((task) => task.threadId === threadId));
  return { bot, room: bot ? undefined : store.groups.find((candidate) => roomThreads(candidate).includes(threadId)) };
};

/** A conversation's rows after a point, a page at a time, as main sends them on; null when no bot or room here has it. */
export function chatPage({ store, dataDir }: CloudSendChatsDeps, threadId: string, after: number, afterId: string | null) {
  const { bot, room } = ownerOf(store, threadId);
  if ((!bot && !room) || !Number.isSafeInteger(after) || after < 0) return null;
  const path = activePath(store.messagesFor(threadId), store.activeLeaf(threadId)).map((row) => row.id);
  const page = threadRowsAfter(threadId, after, afterId, CHAT_ROWS_PAGE, CHAT_PAGE_BYTES, path);
  const task = bot ? taskOf(bot, threadId) : room!.tasks?.find((candidate) => candidate.threadId === threadId) ?? null;
  const owner = bot ? { bot: bot.id, task: task ? sentTask(task as TaskRecord) : null }
    : { room: room!.id, roomInfo: sentRoom(room!), task: task ? sentRoomTask(task as GroupTaskRecord) : null };
  return { v: 1, ...owner, threadId, ...page,
    attachments: [...new Set(page.rows.flatMap((row) => attachmentNames(row as Message, dataDir)))] };
}

/** A conversation's stored row ids and the ids of its visible path, root first, each from `from` on, VERIFY_IDS at a
 * time; null when no bot or room here has it. Ids only: what a move checks My Cloud has. */
export function chatIds({ store }: CloudSendChatsDeps, threadId: string, from: number) {
  const { bot, room } = ownerOf(store, threadId);
  if ((!bot && !room) || !Number.isSafeInteger(from) || from < 0) return null;
  const rows = store.messagesFor(threadId);
  const path = activePath(rows, store.activeLeaf(threadId)).map((row) => row.id);
  return { v: 1, ids: rows.slice(from, from + VERIFY_IDS).map((row) => row.id), path: path.slice(from, from + VERIFY_IDS), leaf: path.at(-1) ?? null,
    more: from + VERIFY_IDS < Math.max(rows.length, path.length) };
}

/** Whether `ids` appear in this order on `path` after the row `after` (from its start when null), and the last of them
 * found there. */
export function inOrder(path: readonly string[], after: string | null, ids: readonly string[]): { holds: boolean; at: string | null } {
  let at = after === null ? 0 : path.indexOf(after) + 1;
  if (after !== null && at === 0) return { holds: false, at: null };
  let last = after;
  for (const id of ids) {
    const found = path.indexOf(id, at);
    if (found < 0) return { holds: false, at: last };
    at = found + 1;
    last = id;
  }
  return { holds: true, at: last };
}

const idsSchema = z.object({
  v: z.literal(1),
  conversations: z.array(z.object({ threadId: z.string().regex(/^[\w-]{1,200}$/u), ids: z.array(z.string().max(200)).max(VERIFY_IDS) })).max(200),
}).refine((body) => body.conversations.reduce((sum, entry) => sum + entry.ids.length, 0) <= 2 * VERIFY_IDS);

/** My Cloud's side of the move's own lines: of these rows it holds of a bot conversation, each its owner wrote or
 * answered in the window they came from, which an earlier send or a Bring left naming nobody, becomes the owner's as an
 * arriving one does. A room's never do. Ids only. */
export function stampHeld(store: CloudSendChatsDeps["store"], conversations: ReadonlyArray<{ threadId: string; ids: readonly string[] }>, owner: CloudOwner): { stamped: number; threads: string[] } {
  let stamped = 0;
  const threads = new Set<string>();
  for (const { threadId, ids } of conversations) {
    if (!ownerOf(store, threadId).bot) continue;
    const named = new Set(ids);
    for (const row of store.messagesFor(threadId)) {
      const stamp = named.has(row.id) ? ownerStamp(row, owner) : null;
      if (!stamp || !store.patchMessage(threadId, row.id, stamp)) continue;
      stamped++;
      threads.add(threadId);
    }
  }
  return { stamped, threads: [...threads] };
}

const verifySchema = z.object({
  v: z.literal(1),
  conversations: z.array(z.object({
    threadId: z.string().regex(/^[\w-]{1,200}$/u),
    ids: z.array(z.string().max(200)).max(VERIFY_IDS).optional(),
    path: z.object({ after: z.string().max(200).nullable(), ids: z.array(z.string().max(200)).max(VERIFY_IDS), last: z.boolean() }).optional(),
  })).max(200),
}).refine((body) => body.conversations.reduce((sum, entry) => sum + (entry.ids?.length ?? 0) + (entry.path?.ids.length ?? 0), 0) <= 2 * VERIFY_IDS);

/** My Cloud's side of checking a move's chats: which of the sent ids it lacks, how many of them are a bot conversation's
 * lines of its owner's that do not carry the owner yet, and whether the sender's visible path holds on its own, in order
 * (a conversation both sides added to weaves the two together). The last chunk of a path also gets My Cloud's leaf and
 * path length, so the sender can tell an equal path from one that holds inside a longer one. Ids only, never a row. */
export function verifyChats(store: ChatStore, conversations: z.infer<typeof verifySchema>["conversations"]) {
  return conversations.map(({ threadId, ids, path }) => {
    const rows = store.messagesFor(threadId);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const bot = Boolean(ownerOf(store, threadId).bot);
    const visible = path ? activePath(rows, store.activeLeaf(threadId)).map((row) => row.id) : [];
    return { threadId, missing: (ids ?? []).filter((id) => !byId.has(id)),
      unstamped: bot ? (ids ?? []).filter((id) => { const row = byId.get(id); return row !== undefined && unstamped(row); }).length : 0,
      ...(path ? { path: { ...inOrder(visible, path.after, path.ids), ...(path.last ? { leaf: visible.at(-1) ?? null, length: visible.length } : {}) } } : {}) };
  });
}

/** False when the path is not one of these routes. */
export async function cloudSendChatsRoute(deps: CloudSendChatsDeps, { req, res, path, method, url, auth, json, readBody }: RouteContext): Promise<boolean> {
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return false;
  res.setHeader("cache-control", "no-store");
  const { store } = deps;
  // This computer's side: what each conversation has, and its rows after a point.
  if (path === PREFIX && method === "GET") {
    const heads = deps.bot ? chatHeads(store.bots.filter((bot) => bot.id === deps.bot), []) : chatHeads(store.bots, store.groups);
    json(res, 200, { v: 1, dataDir: deps.dataDir, ...(deps.bot && deps.ownerKey ? { owner: deps.ownerKey } : {}), conversations: heads.map((head) => ({ ...head, settings: conversationSettings(store, head) })),
      rooms: deps.bot ? [] : emptyRooms(store.groups, heads),
      ...(url.searchParams.get("attachments") === "1" ? { attachments: await attachmentSizes(store, deps.dataDir, heads) } : {}) });
    return true;
  }
  if (path === `${PREFIX}/settings` && method === "POST") {
    if (!deps.owner?.(auth)) { json(res, 403, { error: "Only My Cloud's owner can set its conversations as they were." }); return true; }
    const parsed = settingsSchema.safeParse(await readBody(req, 1024 * 1024));
    if (!parsed.success) { json(res, 400, { error: "send { v: 1, conversations: [{ threadId, settings }] }" }); return true; }
    json(res, 200, { v: 1, changed: adoptConversationSettings(store, parsed.data.conversations,
      { instance: (id) => deps.instanceExists?.(id) ?? false, approval: (selection, mode) => deps.approvalSupported?.(selection, mode) ?? false }) });
    return true;
  }
  if (path === `${PREFIX}/ids` && method === "GET") {
    const ids = chatIds(deps, url.searchParams.get("thread") ?? "", Number(url.searchParams.get("from") ?? 0));
    if (!ids) json(res, 404, { error: "no such conversation" });
    else json(res, 200, ids);
    return true;
  }
  if (path === `${PREFIX}/verify` && method === "POST") {
    const parsed = verifySchema.safeParse(await readBody(req, 2 * 1024 * 1024));
    if (!parsed.success) { json(res, 400, { error: `send { v: 1, conversations: [{ threadId, ids, path }] }, at most ${VERIFY_IDS} ids of each` }); return true; }
    json(res, 200, { v: 1, conversations: verifyChats(store, parsed.data.conversations) });
    return true;
  }
  if (path === `${PREFIX}/owner` && method === "POST") {
    const owner = deps.owner?.(auth) ?? null;
    if (!owner) { json(res, 403, { error: "Only My Cloud's owner can say which of its lines are theirs." }); return true; }
    const parsed = idsSchema.safeParse(await readBody(req, 2 * 1024 * 1024));
    if (!parsed.success) { json(res, 400, { error: `send { v: 1, conversations: [{ threadId, ids }] }, at most ${VERIFY_IDS} ids of each` }); return true; }
    const { stamped, threads } = stampHeld(store, parsed.data.conversations, owner);
    for (const threadId of threads) deps.stamped?.(threadId);
    json(res, 200, { v: 1, stamped });
    return true;
  }
  if (path === `${PREFIX}/rows` && method === "GET") {
    const page = chatPage(deps, url.searchParams.get("thread") ?? "", Number(url.searchParams.get("after") ?? 0), url.searchParams.get("id"));
    if (!page) json(res, 404, { error: "no such conversation" });
    else json(res, 200, page);
    return true;
  }
  const named = /^\/api\/cloud-send\/chats\/attachment\/([^/]+)$/u.exec(path)?.[1];
  if (named !== undefined) {
    if (!ATTACHMENT_NAME.test(named)) { json(res, 404, { error: "no such attachment" }); return true; }
    const file = join(ATTACHMENTS_DIR, named);
    if (method === "GET") {
      const stat = await lstat(file).catch(() => null);
      if (!stat?.isFile() || stat.size > FILE_MAX_BYTES) { json(res, 404, { error: "no such attachment" }); return true; }
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(stat.size) });
      res.end(await readFile(file));
      return true;
    }
    // My Cloud's side: an attachment a sent row names, kept under its own name; one already here is the same upload.
    if (method === "POST") {
      const declared = Number(req.headers["content-length"]);
      try {
        const saved = await saveNamedAttachment(named, req, Number.isSafeInteger(declared) && declared >= 0 ? declared : undefined);
        json(res, saved.stored ? 201 : 200, saved);
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status !== 413 && status !== 507) throw error;
        req.resume();
        json(res, status, { error: (error as Error).message, ...(status === 507 ? { full: true } : {}) });
      }
      return true;
    }
    json(res, 405, { error: "method not allowed" });
    return true;
  }
  if (path === `${PREFIX}/attachments` && method === "POST") {
    const body = z.object({ names: z.array(z.string()).max(2000) }).safeParse(await readBody(req, 256 * 1024));
    if (!body.success) { json(res, 400, { error: "send { names }" }); return true; }
    const missing: string[] = [];
    for (const name of new Set(body.data.names)) {
      if (!ATTACHMENT_NAME.test(name)) continue;
      const handle = await open(join(ATTACHMENTS_DIR, name), "r").catch(() => null);
      if (handle) await handle.close(); else missing.push(name);
    }
    json(res, 200, { missing });
    return true;
  }
  if (path === PREFIX && method === "POST") {
    const parsed = sentSchema.safeParse(await readBody(req, CHATS_BODY_MAX));
    if (!parsed.success) { json(res, 400, { error: "send { v: 1, dataDir, conversations }" }); return true; }
    const busy = new Set<string>();
    for (const bot of store.bots) {
      if (bot.busy) busy.add(bot.threadId);
      for (const task of bot.tasks ?? []) if (task.busy) busy.add(task.threadId);
    }
    for (const room of store.groups) if (room.busyBotId) for (const threadId of [room.threadId, ...(room.tasks ?? []).map((task) => task.threadId)]) busy.add(threadId);
    const result = addSentChats(store, deps.dataDir, parsed.data.dataDir, parsed.data.conversations as unknown as SentConversation[],
      { busy: (threadId) => busy.has(threadId), owner: deps.owner?.(auth) ?? null });
    json(res, 200, result);
    return true;
  }
  json(res, 405, { error: "method not allowed" });
  return true;
}
