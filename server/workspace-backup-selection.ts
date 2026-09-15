import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import type { WorkspaceBackupSelection } from "../shared/workspace-backup.ts";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Choose a valid calendar date.");
export const backupSelectionSchema = z.object({
  conversations: z.boolean().default(true), attachments: z.boolean().default(true),
  workspaceFiles: z.boolean().default(true), from: day.optional(), to: day.optional(),
}).strict().refine(value => !value.from || !value.to || value.from <= value.to, "The start date must be before the end date.");

export function backupCategory(path: string): "settings" | "conversations" | "attachments" | "workspaceFiles" {
  if (path === "messages.db" || /^messages-[^/]+\.json$/.test(path)) return "conversations";
  if (path === "attachments" || path.startsWith("attachments/")) return "attachments";
  if (/^(task-workspaces|vm-home|vm-homes)(\/|$)/.test(path)) return "workspaceFiles";
  if (/^workspaces\/[^/]+\//.test(path)) {
    const subpath = path.split("/").slice(2).join("/");
    // Instructions, memory and installed skills belong to the bot setup.
    if (!/^(SOUL\.md|MEMORY\.md|AGENTS\.md|IDENTITY\.md|USER\.md)$/.test(subpath) &&
      !/^(memory|skills|\.claude|\.agents|\.grok)(\/|$)/.test(subpath)) return "workspaceFiles";
  }
  return "settings";
}

export function conversationDateMatches(at: unknown, selection: WorkspaceBackupSelection): boolean {
  const value = typeof at === "number" ? at : typeof at === "string" ? Date.parse(at) : NaN;
  return Number.isFinite(value) && (!selection.from || value >= Date.parse(`${selection.from}T00:00:00Z`)) &&
    (!selection.to || value < Date.parse(`${selection.to}T00:00:00Z`) + 86_400_000);
}

/** Select whole threads so parent/reply links and the beginning of a conversation survive. */
export function selectedBackupThreads(db: DatabaseSync, selection: WorkspaceBackupSelection): Set<string> | null {
  if (!selection.conversations) return new Set();
  if (!selection.from && !selection.to) return null;
  const result = new Set<string>();
  for (const row of db.prepare("SELECT thread_id, json FROM messages").iterate()) {
    const message = JSON.parse(String(row.json));
    if (conversationDateMatches(message.at, selection)) result.add(String(row.thread_id));
  }
  return result;
}

export function filterBackupDatabase(db: DatabaseSync, selected: Set<string>): void {
  db.exec("CREATE TEMP TABLE backup_threads (id TEXT PRIMARY KEY)");
  const insert = db.prepare("INSERT INTO backup_threads VALUES (?)");
  for (const id of selected) insert.run(id);
  db.exec("BEGIN; DELETE FROM messages WHERE thread_id NOT IN (SELECT id FROM backup_threads); DELETE FROM thread_state WHERE thread_id NOT IN (SELECT id FROM backup_threads)");
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_followups'").get()) {
    db.exec("DELETE FROM chat_followups WHERE thread_id NOT IN (SELECT id FROM backup_threads)");
  }
  db.exec("COMMIT; DROP TABLE backup_threads");
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='messages_fts'").get()) {
    db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");
  }
  db.exec("VACUUM");
}

export function backupSelectionNotes(selection: WorkspaceBackupSelection): string[] {
  const notes: string[] = [];
  if (!selection.conversations) notes.push("Conversation history was not included. Bot instructions, memory and settings are included.");
  else if (selection.from || selection.to) notes.push(`Only whole conversations active from ${selection.from ?? "the beginning"} through ${selection.to ?? "any later date"} (UTC) are included, along with their earlier context. Other conversations restore without history. Date selection does not filter attachments or workspace files.`);
  if (!selection.attachments) notes.push("Attached images, videos and uploaded files were not included. Messages may refer to unavailable attachments.");
  if (!selection.workspaceFiles) notes.push("Workspace project files and managed desktop files were not included. Instructions, memory and skills are included; projects may need to be restored separately.");
  return notes;
}
