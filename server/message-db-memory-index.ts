import type { DatabaseSync } from "node:sqlite";

import { ensureSearchIndex } from "./cjk-search.ts";

export function ensureMemoryIndex(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_files (
      bot_id TEXT NOT NULL,
      path TEXT NOT NULL,
      text TEXT NOT NULL,
      mtime_ms INTEGER NOT NULL,
      bytes INTEGER NOT NULL,
      PRIMARY KEY (bot_id, path)
    );
  `);
  ensureSearchIndex(db, { table: "memory_files", fts: "memory_fts", view: "memory_search", triggerPrefix: "memory_fts" });
}
