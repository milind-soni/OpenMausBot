import { mkdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { integrationBridge } from "./integration-bridge";

type LocalUser = { _id: Id<"users">; name: string; username?: string; email: string; avatarUrl?: string | null; role?: string };
export type LocalWorkspaceUser = LocalUser & { teamId: Id<"teams">; workspaceRole: string; slug: string; conversation?: string };
export type DirectConversation = { id: string; otherUserId: string; lastMessage?: LocalChatMessage; unread: number };
export type ChatAttachment = { id: string; name: string; size: number; contentType: string; projectId?: Id<"projects"> };
export type ChatReference = { type: "project" | "issue"; id: string; projectId: string; label: string };
export type ChatMention = { userId: Id<"users">; name: string };
export type LocalChatMessage = {
  id: string; authorUserId: Id<"users">; authorName: string; authorEmail: string; avatarUrl?: string | null;
  body: string; createdAt: number; editedAt?: number; replyTo?: string; pinned?: boolean;
  attachments?: ChatAttachment[]; references?: ChatReference[]; mentions?: ChatMention[]; reactions?: Record<string, string[]>;
};
export type LocalVoiceParticipant = {
  userId: Id<"users">; name: string; username?: string; email: string; avatarUrl?: string | null;
  audioEnabled: boolean; videoEnabled: boolean; screenSharing?: boolean; joinedAt: number; lastSeenAt: number;
};
export type LocalVoiceSignal = { id: string; fromUserId: Id<"users">; toUserId: Id<"users">; fromJoinedAt?: number; toJoinedAt?: number; kind: "offer" | "answer" | "candidate"; payload: string; createdAt: number };

let convexClient: ConvexHttpClient | null = null;
let database: DatabaseSync | null = null;
export function localDataDir() { return process.env.ORIGIN_LOCAL_DATA_DIR || path.join(process.cwd(), ".origin-data"); }
function db() {
  if (database) return database;
  mkdirSync(localDataDir(), { recursive: true });
  database = new DatabaseSync(path.join(localDataDir(), "origin.sqlite"));
  database.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, team TEXT NOT NULL, created INTEGER NOT NULL, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS messages_team_created ON messages(team, created);
    CREATE TABLE IF NOT EXISTS participants (team TEXT NOT NULL, user TEXT NOT NULL, seen INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(team,user));
    CREATE TABLE IF NOT EXISTS signals (id TEXT PRIMARY KEY, team TEXT NOT NULL, recipient TEXT NOT NULL, sender TEXT NOT NULL, created INTEGER NOT NULL, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS signals_team_recipient ON signals(team,recipient);
    CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, team TEXT NOT NULL, author TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS notification_outbox (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS request_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS direct_conversations (id TEXT NOT NULL, team TEXT NOT NULL, user_a TEXT NOT NULL, user_b TEXT NOT NULL, PRIMARY KEY(team,id));
    CREATE TABLE IF NOT EXISTS chat_reads (team TEXT NOT NULL, conversation TEXT NOT NULL, user TEXT NOT NULL, seen INTEGER NOT NULL, PRIMARY KEY(team,conversation,user));`);
  // Existing workspace messages and files remain in the shared conversation.
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const table of ["messages", "files"]) {
      const columns = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!columns.some(column => column.name === "conversation")) database.exec(`ALTER TABLE ${table} ADD COLUMN conversation TEXT NOT NULL DEFAULT ''`);
    }
    database.exec("CREATE INDEX IF NOT EXISTS messages_conversation_created ON messages(team,conversation,created); COMMIT");
  } catch (error) { database.exec("ROLLBACK"); database.close(); database = null; throw error; }
  return database;
}
export class TooManyRequests extends Error {
  constructor() { super("Too many requests. Please try again shortly."); }
}
let limitsSwept = 0;
export function limitLocalAction(key: string, maximum: number, durationMs: number) {
  const now = Date.now();
  if (now - limitsSwept > 600000) { limitsSwept = now; db().prepare("DELETE FROM request_limits WHERE expires<?").run(now); }
  const row = db().prepare("INSERT INTO request_limits(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires<? THEN 1 ELSE count+1 END, expires=CASE WHEN expires<? THEN ? ELSE expires END RETURNING count").get(key, now + durationMs, now, now, now + durationMs) as { count: number };
  if (row.count > maximum) throw new TooManyRequests();
}
/** True when `key` already used up `maximum` in its current window; does not count a request. */
export function localLimitReached(key: string, maximum: number) {
  const row = db().prepare("SELECT count FROM request_limits WHERE key=? AND expires>=?").get(key, Date.now()) as { count: number } | undefined;
  return (row?.count ?? 0) >= maximum;
}
export function getConvexClient() {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("Backend unavailable");
  convexClient ??= new ConvexHttpClient(url); return convexClient;
}
export function sessionTokenFromRequest(request: Request, body?: { sessionToken?: unknown }) {
  const auth = request.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return typeof body?.sessionToken === "string" ? body.sessionToken : "";
}
// Convex can briefly answer with a generic 500; retry those instead of failing call signaling.
async function queryWithRetry<T>(run: () => Promise<T>) {
  for (let attempt = 0; ; attempt++) {
    try { return await run(); }
    catch (error) {
      const transient = error instanceof Error && /InternalServerError|Overloaded|fetch failed|ECONNRESET|ETIMEDOUT/.test(error.message);
      if (!transient || attempt === 2) { if (transient) console.error("Convex query failed after retries:", error.message); throw error; }
      await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
}
export async function requireLocalUser(sessionToken: string) {
  if (!sessionToken) throw new Error("Your session has expired. Sign in again.");
  const user = await queryWithRetry(() => getConvexClient().query(api.auth.me, { sessionToken })) as LocalUser | null;
  if (!user) throw new Error("Your session has expired. Sign in again."); return user;
}
// Calls poll every second; reuse a recent access check instead of asking Convex on every request.
const workspaceAccessCache = new Map<string, { user: LocalWorkspaceUser; expires: number }>();
const WORKSPACE_ACCESS_TTL = 15_000;
export async function requireLocalWorkspace(request: Request, body?: { sessionToken?: unknown; teamId?: unknown }): Promise<LocalWorkspaceUser> {
  const token = sessionTokenFromRequest(request, body);
  const teamId = new URL(request.url).searchParams.get("teamId") || (typeof body?.teamId === "string" ? body.teamId : "");
  if (!teamId) throw new Error("Workspace required");
  const key = `${token}\n${teamId}`, cached = workspaceAccessCache.get(key);
  if (token && cached && cached.expires > Date.now()) return cached.user;
  const [user, access] = await Promise.all([requireLocalUser(token), queryWithRetry(() => getConvexClient().query(api.workspaces.access, { sessionToken: token, teamId: teamId as Id<"teams"> }))]);
  const scoped = { ...user, teamId: access.teamId, workspaceRole: access.role, slug: access.slug };
  if (process.env.ORIGIN_LEGACY_WORKSPACE_ID === access.teamId) migrateLegacy(scoped);
  await importConvexChat(access.teamId);
  if (workspaceAccessCache.size > 500) for (const [entry, value] of workspaceAccessCache) if (value.expires <= Date.now()) workspaceAccessCache.delete(entry);
  workspaceAccessCache.set(key, { user: scoped, expires: Date.now() + WORKSPACE_ACCESS_TTL });
  return scoped;
}
export async function requireLocalChat(request: Request, body?: { sessionToken?: unknown; teamId?: unknown }) {
  const user = await requireLocalWorkspace(request, body);
  const conversation = new URL(request.url).searchParams.get("conversation") || "";
  if (conversation) {
    const row = db().prepare("SELECT id FROM direct_conversations WHERE team=? AND id=? AND (user_a=? OR user_b=?)").get(user.teamId, conversation, user._id, user._id);
    if (!row) throw new Error("Conversation not found");
  }
  return { ...user, conversation };
}
export function openDirectConversation(user: LocalWorkspaceUser, recipientId: string) {
  requireWriter(user);
  if (!recipientId || recipientId === user._id) throw new Error("Choose another workspace member");
  const [first, second] = [user._id, recipientId].sort();
  const id = `dm:${first}:${second}`;
  db().prepare("INSERT OR IGNORE INTO direct_conversations(id,team,user_a,user_b) VALUES(?,?,?,?)").run(id, user.teamId, first, second);
  return id;
}
export function listDirectConversations(user: LocalWorkspaceUser): DirectConversation[] {
  const rows = db().prepare(`SELECT c.id, CASE WHEN c.user_a=? THEN c.user_b ELSE c.user_a END AS otherUserId,
    (SELECT payload FROM messages WHERE team=c.team AND conversation=c.id ORDER BY created DESC LIMIT 1) AS last,
    (SELECT count(*) FROM messages m WHERE m.team=c.team AND m.conversation=c.id AND m.created>COALESCE(r.seen,0) AND json_extract(m.payload,'$.authorUserId')<>?) AS unread
    FROM direct_conversations c LEFT JOIN chat_reads r ON r.team=c.team AND r.conversation=c.id AND r.user=?
    WHERE c.team=? AND (c.user_a=? OR c.user_b=?)`).all(user._id, user._id, user._id, user.teamId, user._id, user._id) as { id: string; otherUserId: string; last: string | null; unread: number }[];
  return rows.map(({ last, ...row }) => ({ ...row, lastMessage: last ? JSON.parse(last) as LocalChatMessage : undefined })).sort((a, b) => (b.lastMessage?.createdAt || 0) - (a.lastMessage?.createdAt || 0));
}
export function markConversationRead(user: LocalWorkspaceUser, messageId: string) {
  const message = messageById(user, messageId);
  db().prepare("INSERT INTO chat_reads VALUES(?,?,?,?) ON CONFLICT(team,conversation,user) DO UPDATE SET seen=MAX(seen,excluded.seen)").run(user.teamId, user.conversation || "", user._id, message.createdAt);
}
function migrateLegacy(user: LocalWorkspaceUser) {
  const database = db();
  if (database.prepare("SELECT name FROM migrations WHERE name='legacy-chat'").get()) return;
  let messages: LocalChatMessage[] = [];
  try { messages = JSON.parse(readFileSync(path.join(localDataDir(), "realtime.json"), "utf8")).messages || []; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const message of messages) database.prepare("INSERT OR IGNORE INTO messages(id,team,created,payload) VALUES(?,?,?,?)").run(message.id, user.teamId, message.createdAt, JSON.stringify(message));
    database.prepare("INSERT OR IGNORE INTO migrations VALUES('legacy-chat')").run(); database.exec("COMMIT");
  } catch (error) { database.exec("ROLLBACK"); throw error; }
}
type ExportPage<T> = { rows: T[]; isDone: boolean; continueCursor: string };
type ExportedMessage = { conversation: string; id: string; created: number; payload: string };
type ExportedFile = { conversation: string; id: string; author: string; payload: string; url: string | null };
const chatImports = new Map<string, Promise<void>>();
const chatImportRetryAt = new Map<string, number>();
/**
 * Copies a workspace's chat from Convex (written by the desktop app before the upgrade) into the local store once:
 * workspace and direct messages, direct conversations, read markers and attachment files. A failed copy is retried
 * after five minutes and never blocks chat.
 */
export function importConvexChat(teamId: string): Promise<void> {
  const name = `convex-chat:${teamId}`;
  if (db().prepare("SELECT name FROM migrations WHERE name=?").get(name) || (chatImportRetryAt.get(teamId) ?? 0) > Date.now()) return Promise.resolve();
  let running = chatImports.get(teamId);
  if (!running) {
    running = copyConvexChat(teamId, name)
      .catch(error => { chatImportRetryAt.set(teamId, Date.now() + 300000); console.error("Chat import failed:", error instanceof Error ? error.message : error); })
      .finally(() => chatImports.delete(teamId));
    chatImports.set(teamId, running);
  }
  return running;
}
async function copyConvexChat(teamId: string, name: string) {
  const all = async <T,>(table: string) => {
    const rows: T[] = [];
    for (let cursor: string | null = null; ;) {
      const page: ExportPage<T> = await integrationBridge<ExportPage<T>>("legacyChat", { teamId, table, cursor });
      rows.push(...page.rows);
      if (page.isDone) return rows;
      cursor = page.continueCursor;
    }
  };
  const messages = await all<ExportedMessage>("messages");
  const files = await all<ExportedFile>("files");
  const directs = await all<{ id: string; userA: string; userB: string }>("directs");
  const reads = await all<{ conversation: string; userId: string; seen: number }>("reads");
  const dir = path.join(localDataDir(), "files");
  if (files.length) await mkdir(dir, { recursive: true });
  const copied = [];
  for (const file of files) {
    if (!/^[a-f0-9-]{36}$/.test(file.id) || !file.url) continue;
    const response = await fetch(file.url, { signal: AbortSignal.timeout(60000), cache: "no-store" });
    if (!response.ok) continue;
    try { await writeFile(path.join(dir, file.id), Buffer.from(await response.arrayBuffer()), { flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    copied.push(file);
  }
  const database = db();
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const row of messages) database.prepare("INSERT OR IGNORE INTO messages(id,team,created,payload,conversation) VALUES(?,?,?,?,?)").run(row.id, teamId, row.created, row.payload, row.conversation);
    for (const row of copied) database.prepare("INSERT OR IGNORE INTO files(id,team,author,payload,conversation) VALUES(?,?,?,?,?)").run(row.id, teamId, row.author, row.payload, row.conversation);
    for (const row of directs) database.prepare("INSERT OR IGNORE INTO direct_conversations(id,team,user_a,user_b) VALUES(?,?,?,?)").run(row.id, teamId, row.userA, row.userB);
    for (const row of reads) database.prepare("INSERT INTO chat_reads VALUES(?,?,?,?) ON CONFLICT(team,conversation,user) DO UPDATE SET seen=MAX(seen,excluded.seen)").run(teamId, row.conversation, row.userId, row.seen);
    database.prepare("INSERT OR IGNORE INTO migrations VALUES(?)").run(name);
    database.exec("COMMIT");
  } catch (error) { database.exec("ROLLBACK"); throw error; }
}
function requireWriter(user: LocalWorkspaceUser) { if (user.workspaceRole === "viewer") throw new Error("View-only workspace access"); }
function messageById(user: LocalWorkspaceUser, id: string) {
  const row = db().prepare("SELECT payload FROM messages WHERE team=? AND conversation=? AND id=?").get(user.teamId, user.conversation || "", id) as { payload: string } | undefined;
  if (!row) throw new Error("Message not found"); return JSON.parse(row.payload) as LocalChatMessage;
}
export async function listLocalMessages(user: LocalWorkspaceUser, before?: number) {
  const rows = db().prepare("SELECT payload FROM messages WHERE team=? AND conversation=? AND created<? ORDER BY created DESC LIMIT 100").all(user.teamId, user.conversation || "", before || Date.now() + 1) as { payload: string }[];
  return rows.reverse().map(row => JSON.parse(row.payload) as LocalChatMessage);
}
export async function searchLocalMessages(user: LocalWorkspaceUser, search: string, before?: number) {
  const text = search.trim().slice(0, 160);
  if (!text) return [];
  limitLocalAction(`chat-search:${user.teamId}:${user._id}`, 90, 60000);
  const rows = db().prepare("SELECT payload FROM messages WHERE team=? AND conversation=? AND created<? AND instr(lower(json_extract(payload,'$.body')),lower(?))>0 ORDER BY created DESC LIMIT 100").all(user.teamId, user.conversation || "", before || Date.now() + 1, text) as { payload: string }[];
  return rows.reverse().map(row => JSON.parse(row.payload) as LocalChatMessage);
}
export async function localMessageContext(user: LocalWorkspaceUser, id: string) { const message = messageById(user, id); return listLocalMessages(user, message.createdAt + 1); }
export async function flushChatNotifications() {
  const rows = db().prepare("SELECT id,payload FROM notification_outbox LIMIT 20").all() as { id: string; payload: string }[];
  for (const row of rows) { await integrationBridge("chatMentions", JSON.parse(row.payload)); db().prepare("DELETE FROM notification_outbox WHERE id=?").run(row.id); }
}
export async function sendLocalMessage(user: LocalWorkspaceUser, body: string, extras: { attachmentIds?: string[]; references?: ChatReference[]; replyTo?: string; mentions?: ChatMention[]; notifyUserIds?: Id<"users">[] } = {}, requestMessageId?: string) {
  requireWriter(user); limitLocalAction(`chat:${user.teamId}:${user._id}`, 40, 60000);
  if (typeof body !== "string" || body.length > 8000) throw new Error("Message must be under 8,000 characters");
  const attachments = (extras.attachmentIds || []).slice(0, 8).map(id => {
    const file = db().prepare("SELECT payload FROM files WHERE id=? AND team=? AND author=? AND conversation=?").get(id, user.teamId, user._id, user.conversation || "") as { payload: string } | undefined;
    if (!file) throw new Error("Attachment not found"); return JSON.parse(file.payload) as ChatAttachment;
  });
  if (!body.trim() && !attachments.length && !extras.references?.length && !extras.mentions?.length) throw new Error("Write a message or add an attachment");
  if (extras.replyTo) messageById(user, extras.replyTo);
  if (requestMessageId) {
    const existing = db().prepare("SELECT payload FROM messages WHERE team=? AND conversation=? AND id=?").get(user.teamId, user.conversation || "", requestMessageId) as { payload: string } | undefined;
    if (existing) { const message = JSON.parse(existing.payload) as LocalChatMessage; if (message.authorUserId !== user._id || message.body !== body.trim()) throw new Error("Message request changed"); return message; }
  }
  const message: LocalChatMessage = { id: requestMessageId || crypto.randomUUID(), authorUserId: user._id, authorName: user.name || user.email, authorEmail: user.email, avatarUrl: user.avatarUrl, body: body.trim(), createdAt: Date.now(), attachments, references: (extras.references || []).slice(0, 12), mentions: extras.mentions || [], ...(extras.replyTo ? { replyTo: extras.replyTo } : {}) };
  const database = db(); database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare("INSERT INTO messages(id,team,created,payload,conversation) VALUES(?,?,?,?,?)").run(message.id, user.teamId, message.createdAt, JSON.stringify(message), user.conversation || "");
    const userIds = [...new Set([...(extras.mentions || []).map(m => m.userId), ...(extras.notifyUserIds || [])])].filter(id => id !== user._id).slice(0, 20);
    if (userIds.length && !user.conversation) database.prepare("INSERT INTO notification_outbox VALUES(?,?)").run(message.id, JSON.stringify({ teamId: user.teamId, actorId: user._id, messageId: message.id, userIds }));
    database.exec("COMMIT");
  } catch (error) { database.exec("ROLLBACK"); throw error; }
  return message;
}
export async function editLocalMessage(user: LocalWorkspaceUser, id: string, change: { body?: string; reaction?: string; pinned?: boolean; delete?: boolean }) {
  requireWriter(user);
  const database = db(); database.exec("BEGIN IMMEDIATE");
  try {
    const message = messageById(user, id);
    if (change.delete || change.body !== undefined) {
      if (message.authorUserId !== user._id) throw new Error("Only the author can edit or delete this message");
      if (change.delete) { database.prepare("DELETE FROM messages WHERE team=? AND id=?").run(user.teamId, id); database.exec("COMMIT"); return null; }
      if (!change.body?.trim() || change.body.length > 8000) throw new Error("Enter a message under 8,000 characters");
      message.body = change.body.trim(); message.editedAt = Date.now();
    }
    if (change.reaction) {
      if (!["like", "heart", "celebrate", "eyes"].includes(change.reaction)) throw new Error("Unknown reaction");
      message.reactions ||= {}; const users = message.reactions[change.reaction] || [];
      message.reactions[change.reaction] = users.includes(user._id) ? users.filter(id => id !== user._id) : [...users, user._id];
    }
    if (typeof change.pinned === "boolean") message.pinned = change.pinned;
    database.prepare("UPDATE messages SET payload=? WHERE team=? AND id=?").run(JSON.stringify(message), user.teamId, id); database.exec("COMMIT"); return message;
  } catch (error) { database.exec("ROLLBACK"); throw error; }
}
export function registerLocalFile(user: LocalWorkspaceUser, file: ChatAttachment) { requireWriter(user); db().prepare("INSERT INTO files(id,team,author,payload,conversation) VALUES(?,?,?,?,?)").run(file.id, user.teamId, user._id, JSON.stringify(file), user.conversation || ""); }
export function getLocalFile(user: LocalWorkspaceUser, id: string) {
  const row = db().prepare("SELECT payload FROM files WHERE team=? AND conversation=? AND id=?").get(user.teamId, user.conversation || "", id) as { payload: string } | undefined;
  if (!row) throw new Error("File not found"); return JSON.parse(row.payload) as ChatAttachment;
}
function pruneVoice() { db().prepare("DELETE FROM participants WHERE seen<?").run(Date.now() - 30000); db().prepare("DELETE FROM signals WHERE created<?").run(Date.now() - 120000); }
export async function listLocalVoiceParticipants(user: LocalWorkspaceUser) {
  pruneVoice(); return (db().prepare("SELECT payload FROM participants WHERE team=? ORDER BY seen").all(user.teamId) as { payload: string }[]).map(row => JSON.parse(row.payload) as LocalVoiceParticipant);
}
export async function joinLocalVoice(user: LocalWorkspaceUser, audioEnabled: boolean, videoEnabled: boolean, screenSharing = false, heartbeat = false) {
  requireWriter(user); pruneVoice();
  const active = await listLocalVoiceParticipants(user);
  if (active.length >= 8 && !active.some(p => p.userId === user._id)) throw new Error("This room is full (8 people)");
  const previous = active.find(p => p.userId === user._id);
  if (!heartbeat) db().prepare("DELETE FROM signals WHERE team=? AND (sender=? OR recipient=?)").run(user.teamId, user._id, user._id);
  const participant: LocalVoiceParticipant = { userId: user._id, name: user.name, username: user.username, email: user.email, avatarUrl: user.avatarUrl, audioEnabled, videoEnabled, screenSharing, joinedAt: heartbeat && previous ? previous.joinedAt : Math.max(Date.now(), (previous?.joinedAt || 0) + 1), lastSeenAt: Date.now() };
  db().prepare("INSERT INTO participants VALUES(?,?,?,?) ON CONFLICT(team,user) DO UPDATE SET seen=excluded.seen,payload=excluded.payload").run(user.teamId, user._id, Date.now(), JSON.stringify(participant)); return participant;
}
export async function updateLocalVoicePresence(user: LocalWorkspaceUser, audioEnabled: boolean, videoEnabled: boolean, screenSharing = false) { return joinLocalVoice(user, audioEnabled, videoEnabled, screenSharing, true); }
export async function leaveLocalVoice(user: LocalWorkspaceUser) {
  db().prepare("DELETE FROM participants WHERE team=? AND user=?").run(user.teamId, user._id);
  db().prepare("DELETE FROM signals WHERE team=? AND (sender=? OR recipient=?)").run(user.teamId, user._id, user._id);
}
export async function sendLocalVoiceSignal(user: LocalWorkspaceUser, toUserId: Id<"users">, kind: LocalVoiceSignal["kind"], payload: string, fromJoinedAt?: number, toJoinedAt?: number) {
  requireWriter(user);
  if (toUserId === user._id || !["offer", "answer", "candidate"].includes(kind) || typeof payload !== "string" || !payload || payload.length > 80000) throw new Error("Invalid call signal");
  const active = await listLocalVoiceParticipants(user);
  const sender = active.find(p => p.userId === user._id), recipient = active.find(p => p.userId === toUserId);
  // A peer that just left (or a stale participant list on the sender) is a normal race, not a client error.
  if (!sender || !recipient) return null;
  if ((fromJoinedAt !== undefined && fromJoinedAt !== sender.joinedAt) || (toJoinedAt !== undefined && toJoinedAt !== recipient.joinedAt)) return null;
  const signal: LocalVoiceSignal = { id: crypto.randomUUID(), fromUserId: user._id, toUserId, fromJoinedAt: sender.joinedAt, toJoinedAt: recipient.joinedAt, kind, payload, createdAt: Date.now() };
  db().prepare("INSERT INTO signals VALUES(?,?,?,?,?,?)").run(signal.id, user.teamId, toUserId, user._id, signal.createdAt, JSON.stringify(signal)); return signal;
}
export async function listLocalVoiceSignals(user: LocalWorkspaceUser) {
  return (db().prepare("SELECT payload FROM signals WHERE team=? AND recipient=? AND created>? ORDER BY created LIMIT 120").all(user.teamId, user._id, Date.now() - 120000) as { payload: string }[]).map(row => JSON.parse(row.payload) as LocalVoiceSignal);
}
export async function ackLocalVoiceSignals(user: LocalWorkspaceUser, ids: string[]) { for (const id of ids.slice(0, 120)) db().prepare("DELETE FROM signals WHERE team=? AND recipient=? AND id=?").run(user.teamId, user._id, id); }
