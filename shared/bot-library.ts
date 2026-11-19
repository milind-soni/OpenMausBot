/** GET /api/bots/<id>/library: what one bot made in its own conversations the viewer can read (not rooms), newest
 * first. */
export interface BotLibrary {
  /** The pages and app views it showed in chats, each once at its latest version: the newest 200. */
  apps: Array<{ threadId: string; messageId: string; title: string }>;
  /** Its pages online, at their links. */
  pages: Array<{ url: string; title: string }>;
}
