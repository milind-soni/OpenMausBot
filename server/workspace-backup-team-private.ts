// Security: every member reads "only you, not Acme's admins", and a Team Cloud's export is its Owner's. So the export leaves
// out what is one member's alone, decided from the records of who opened each conversation, never from a line's text.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { isLayerId, layerAudience } from "./audience.ts";
import { CLOUD_NOBODY_KEY, CLOUD_OUTSIDE_KEY } from "./cloud-sharing.ts";

const PERSON = /^p_[\w-]{22}$/;
const MARKERS: ReadonlySet<string> = new Set([CLOUD_NOBODY_KEY, CLOUD_OUTSIDE_KEY]);
const IN_CHUNK = 500;

export interface TeamPrivacy {
  /** The conversations that are one member's alone. */
  threads: ReadonlySet<string>;
  /** Each member's own MausBot: everything of it is theirs. */
  bots: ReadonlySet<string>;
  /** Files in attachments/ only those conversations, or a member's unsent uploads, use. */
  attachments: ReadonlySet<string>;
}

type Row = Record<string, unknown>;
const record = (value: unknown): value is Row => value !== null && typeof value === "object" && !Array.isArray(value);
function readJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.filter(record) : []);
const ownBot = (bot: Row): boolean => record(bot.defaultBot) && typeof bot.defaultBot.person === "string" && bot.defaultBot.person.trim() !== "";

/** What a Team Cloud's export must leave out; null anywhere else, where nothing is left out. */
export function teamPrivateThreads(files: { starters: string; groups: string; bots: string }, env: NodeJS.ProcessEnv = process.env): TeamPrivacy | null {
  if (env.OMB_CLOUD_ROLE !== "team") return null;
  const rooms = new Set<string>();
  for (const group of rows(readJson(files.groups))) {
    if (typeof group.threadId === "string") rooms.add(group.threadId);
    for (const task of rows(group.tasks)) if (typeof task.threadId === "string") rooms.add(task.threadId);
  }
  const threads = new Set<string>();
  const starters = readJson(files.starters);
  for (const [threadId, person] of Object.entries(record(starters) ? starters : {})) {
    if (typeof person === "string" && PERSON.test(person) && !MARKERS.has(person) && !rooms.has(threadId)) threads.add(threadId);
  }
  const bots = new Set<string>();
  for (const bot of rows(readJson(files.bots))) {
    if (!ownBot(bot) || typeof bot.id !== "string") continue;
    bots.add(bot.id);
    if (typeof bot.threadId === "string") threads.add(bot.threadId);
    for (const task of rows(bot.tasks)) if (typeof task.threadId === "string") threads.add(task.threadId);
  }
  return { threads, bots, attachments: new Set() };
}

const memberLayer = (id: string): boolean => isLayerId(id) && layerAudience(id).startsWith("member:");

/** A path in the data folder that is one member's: their folder under people/, their inbox, a file only their chats use,
 * or anything named for one of their conversations, their layers or their own bot, wherever it is kept. */
export function omittedAsTeamPrivate(path: string, privacy: TeamPrivacy): boolean {
  if (/^(?:people(?:\/|$)|person-inbox\.json)/.test(path)) return true;
  const attachment = /^attachments\/([^/]+)$/.exec(path)?.[1];
  if (attachment && privacy.attachments.has(attachment)) return true;
  return path.split("/").some((part) => {
    const name = part.replace(/\.[^-]*$/, "");
    return memberLayer(name) || privacy.bots.has(name) || privacy.threads.has(name);
  });
}

/** bots.json without members' own bots and without the private conversations' tasks. */
export function withoutTeamPrivate(bots: unknown, privacy: TeamPrivacy): unknown {
  if (!Array.isArray(bots)) return bots;
  return bots.filter((bot) => !(record(bot) && typeof bot.id === "string" && privacy.bots.has(bot.id))).map((bot) => (record(bot) && Array.isArray(bot.tasks)
    ? { ...bot, tasks: bot.tasks.filter((task) => !(record(task) && typeof task.threadId === "string" && privacy.threads.has(task.threadId))) }
    : bot));
}

function chunks(ids: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let at = 0; at < ids.length; at += IN_CHUNK) out.push(ids.slice(at, at + IN_CHUNK));
  return out;
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function deleteWhereIn(db: DatabaseSync, table: string, column: string, ids: readonly string[]): void {
  if (!hasTable(db, table)) return;
  for (const chunk of chunks(ids)) db.prepare(`DELETE FROM ${table} WHERE ${column} IN (${chunk.map(() => "?").join(", ")})`).run(...chunk);
}

function selectWhereIn(db: DatabaseSync, table: string, select: string, column: string, ids: readonly string[]): string[] {
  if (!hasTable(db, table)) return [];
  const found: string[] = [];
  for (const chunk of chunks(ids)) {
    for (const row of db.prepare(`SELECT ${select} AS id FROM ${table} WHERE ${column} IN (${chunk.map(() => "?").join(", ")})`).all(...chunk)) {
      if (typeof row.id === "string") found.push(row.id);
    }
  }
  return found;
}

/** A snapshot database with the private conversations' rows gone, then rebuilt so neither a search index nor a freed page
 * still holds their words. Only ever a snapshot copy, never the live database. */
function strip(file: string, remove: (db: DatabaseSync) => void): void {
  if (!existsSync(file)) return;
  const db = new DatabaseSync(file);
  try {
    db.exec("BEGIN");
    try { remove(db); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; }
    for (const index of ["messages_fts", "memory_fts"]) if (hasTable(db, index)) db.exec(`INSERT INTO ${index}(${index}) VALUES('rebuild')`);
    db.exec("VACUUM");
  } finally {
    db.close();
  }
}

const ATTACHMENT = /attachments(?:\/|\\)+([A-Za-z0-9][\w.-]{0,200})/g;
const attachmentsIn = (text: string): string[] => [...text.matchAll(ATTACHMENT)].map((match) => match[1]!);

const uploadNames = (value: unknown): string[] => (Array.isArray(value) ? value.filter((name): name is string => typeof name === "string") : []);

function uploadedByMembers(root: string): string[] {
  const people = join(root, "people");
  if (!existsSync(people)) return [];
  return readdirSync(people).flatMap((person) => uploadNames(readJson(join(people, person, "uploads.json"))));
}

/** A member's file stays only if something the team keeps uses it: a line left in the snapshot, or a bot's or room's picture. */
export function teamPrivateAttachments(root: string, messages: string, privacy: TeamPrivacy): ReadonlySet<string> {
  const candidates = new Set(uploadedByMembers(root));
  const kept = new Set<string>();
  for (const file of ["bots.json", "groups.json"]) {
    try { for (const name of attachmentsIn(readFileSync(join(root, file), "utf8"))) kept.add(name); } catch { /* none yet */ }
  }
  if (existsSync(messages)) {
    const db = new DatabaseSync(messages, { readOnly: true });
    try {
      for (const row of db.prepare("SELECT thread_id AS thread, json FROM messages").all()) {
        const names = attachmentsIn(String(row.json));
        for (const name of names) (privacy.threads.has(String(row.thread)) ? candidates : kept).add(name);
      }
    } finally { db.close(); }
  }
  return new Set([...candidates].filter((name) => !kept.has(name)));
}

/** The snapshot copies of the message and runtime databases, without the private conversations. */
export function stripTeamPrivate(snapshot: { messages: string; runtime: string }, privacy: TeamPrivacy): void {
  const threads = [...privacy.threads];
  strip(snapshot.messages, (db) => {
    for (const table of ["messages", "thread_state", "chat_followups", "notification_log"]) deleteWhereIn(db, table, "thread_id", threads);
    // A tool's saved answer, kept only so a retried call repeats it: nothing says whose chat it came from.
    if (hasTable(db, "command_receipts")) db.exec("DELETE FROM command_receipts");
    if (!hasTable(db, "memory_files")) return;
    const indexed = db.prepare("SELECT DISTINCT bot_id AS id FROM memory_files").all().map((row) => String(row.id));
    deleteWhereIn(db, "memory_files", "bot_id", indexed.filter((id) => memberLayer(id) || privacy.bots.has(id)));
  });
  strip(snapshot.runtime, (db) => {
    const assignments = [...new Set([
      ...selectWhereIn(db, "assignments", "id", "requester_thread_id", threads),
      ...selectWhereIn(db, "assignments", "id", "assignee_thread_id", threads),
    ])];
    deleteWhereIn(db, "assignment_events", "assignment_id", assignments);
    deleteWhereIn(db, "inbox", "assignment_id", assignments);
    deleteWhereIn(db, "inbox", "owner_thread_id", threads);
    deleteWhereIn(db, "assignments", "id", assignments);
  });
}

export const TEAM_PRIVATE_NOTE = "Members' private chats are theirs alone and are not in this export: their conversations, what bots remember from them, their own MausBot and their About you stay out.";
