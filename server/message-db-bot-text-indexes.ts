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

/** Building one of these indexes on an existing database reads every row of messages. On macOS, with a 2.2 GB database
 * just copied, the build took 8.6 s; after one sequential pass over the file, pass and build took 1.1 s together. So
 * there, when one of these indexes is missing and the file fits easily in memory, read it once before the build. Only
 * the OS cache changes, and on any error the build runs as before. Elsewhere it is unmeasured, so maxBytes is 0. */
export function warmForBotTextIndexes(db: DatabaseSync, file: string, limits = { minBytes: 64 << 20, maxBytes: process.platform === "darwin" ? totalmem() / 2 : 0 }): boolean {
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
