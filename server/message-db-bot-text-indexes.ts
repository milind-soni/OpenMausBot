import { closeSync, openSync, readSync, statSync } from "node:fs";
import { totalmem } from "node:os";
import type { DatabaseSync } from "node:sqlite";

export const LIBRARY_FILE_REPLY_FILTER = `role = 'bot' AND kind = 'text'
  AND (instr(text, '](') > 0 OR instr(text, ']:') > 0 OR instr(text, '<file:') > 0 OR json_extract(json, '$.attachments') IS NOT NULL)`;

export const BOT_TEXT_MESSAGE_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS messages_thread_bot_text ON messages(thread_id, at) WHERE kind = 'text' AND role = 'bot' AND text IS NOT NULL;
  CREATE INDEX IF NOT EXISTS messages_library_file_replies ON messages(thread_id, role) WHERE ${LIBRARY_FILE_REPLY_FILTER};`;

const INDEX_NAMES = [...BOT_TEXT_MESSAGE_INDEXES_SQL.matchAll(/CREATE INDEX IF NOT EXISTS (\w+)/g)].map((match) => match[1]!);
const CHUNK = 8 << 20;

/** Building one of these indexes on an existing database reads every row of messages, and SQLite reads them a page at a
 * time: on a 2.2 GB database not in the OS cache the build took 8.6 s. One sequential pass over the file first brings it
 * into the cache, and pass and build then took 1.1 s. So when one of these indexes is missing and the file fits easily in
 * memory, read it once before the build. Only the OS cache changes; on any error the build reads the disk as before. */
export function warmForBotTextIndexes(db: DatabaseSync, file: string, limits = { minBytes: 64 << 20, maxBytes: totalmem() / 2 }): boolean {
  try {
    const have = new Set((db.prepare("SELECT name FROM sqlite_master WHERE tbl_name = 'messages'").all() as Array<{ name: string }>).map((row) => row.name));
    if (!have.has("messages") || INDEX_NAMES.every((name) => have.has(name))) return false;
    const size = statSync(file).size;
    if (size < limits.minBytes || size > limits.maxBytes) return false;
    const fd = openSync(file, "r");
    try {
      const buffer = Buffer.allocUnsafe(CHUNK);
      while (readSync(fd, buffer, 0, CHUNK, null) > 0);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}
