/** What one bot made across its conversations, newest first (GET /api/bots/:id/library): its live published pages, its
 * apps, and the files it shared. Each item names the conversation and message it came from. */
export interface BotLibrary {
  pages: BotLibraryPage[];
  apps: BotLibraryApp[];
  files: BotLibraryFileMessage[];
}

export interface BotLibraryPage { threadId: string; messageId: string; at: number; title: string; url: string }

export interface BotLibraryApp { threadId: string; messageId: string; at: number; title: string }

/** One bot reply that shares files: its attached files, and the local file links in its text, as authored. */
export interface BotLibraryFileMessage {
  threadId: string;
  messageId: string;
  at: number;
  attachments: Array<{ path: string; kind?: string; name?: string }>;
  links: string[];
}

/** The most of each group the server sends; the panel shows the newest few and expands in place. */
export const BOT_LIBRARY_MAX = 200;
