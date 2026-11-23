import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BOT_TEXT_MESSAGE_INDEXES_SQL, warmForBotTextIndexes } from "./message-db-bot-text-indexes.ts";

const ANY_SIZE = { minBytes: 0, maxBytes: Number.MAX_SAFE_INTEGER };

describe("warmForBotTextIndexes", () => {
  let dir: string, file: string, db: DatabaseSync;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bot-text-indexes-"));
    file = join(dir, "messages.db");
    db = new DatabaseSync(file);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const createMessages = () => {
    db.exec("CREATE TABLE messages (thread_id TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL, text TEXT, json TEXT NOT NULL, PRIMARY KEY (thread_id, id))");
    db.prepare("INSERT INTO messages VALUES ('t', 'm', 1, 'bot', 'text', '[a](./a.md)', '{}')").run();
  };

  it("reads the file only when an existing messages table is about to build one of the indexes", () => {
    expect(warmForBotTextIndexes(db, file, ANY_SIZE)).toBe(false);
    createMessages();
    expect(warmForBotTextIndexes(db, file, ANY_SIZE)).toBe(true);
    db.exec(BOT_TEXT_MESSAGE_INDEXES_SQL);
    expect(warmForBotTextIndexes(db, file, ANY_SIZE)).toBe(false);
    db.exec("DROP INDEX messages_library_file_replies");
    expect(warmForBotTextIndexes(db, file, ANY_SIZE)).toBe(true);
  });

  it("leaves small files and files too big for memory to the build itself, and a missing file is no error", () => {
    createMessages();
    expect(warmForBotTextIndexes(db, file, { minBytes: Number.MAX_SAFE_INTEGER, maxBytes: Number.MAX_SAFE_INTEGER })).toBe(false);
    expect(warmForBotTextIndexes(db, file, { minBytes: 0, maxBytes: 1 })).toBe(false);
    expect(warmForBotTextIndexes(db, join(dir, "gone.db"), ANY_SIZE)).toBe(false);
  });
});
