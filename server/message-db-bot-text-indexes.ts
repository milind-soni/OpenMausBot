export const LIBRARY_FILE_REPLY_FILTER = `role = 'bot' AND kind = 'text'
  AND (instr(text, '](') > 0 OR instr(text, ']:') > 0 OR instr(text, '<file:') > 0 OR json_extract(json, '$.attachments') IS NOT NULL)`;

export const BOT_TEXT_MESSAGE_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS messages_thread_bot_text ON messages(thread_id, at) WHERE kind = 'text' AND role = 'bot' AND text IS NOT NULL;
  CREATE INDEX IF NOT EXISTS messages_library_file_replies ON messages(thread_id, role) WHERE ${LIBRARY_FILE_REPLY_FILTER};`;
