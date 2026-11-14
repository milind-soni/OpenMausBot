import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";

import { cjkSearchText, ensureSearchIndex, ftsPhrase } from "./cjk-search.ts";

const SPEC = { table: "messages", fts: "messages_fts", view: "messages_search", triggerPrefix: "messages_fts" };
const opened: DatabaseSync[] = [];
function database(legacy = true) {
  const db = new DatabaseSync(":memory:");
  opened.push(db);
  db.exec("CREATE TABLE messages (id TEXT PRIMARY KEY, text TEXT)");
  if (legacy) db.exec(`
    CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='rowid');
    CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
  `);
  db.prepare("INSERT INTO messages VALUES (?, ?)").run("en", "Buy milk tomorrow");
  db.prepare("INSERT INTO messages VALUES (?, ?)").run("zh", "周三去图书馆还书");
  return db;
}
function match(db: DatabaseSync, query: string) {
  return db.prepare("SELECT m.id FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid WHERE messages_fts MATCH ?")
    .all(query).map(row => row.id);
}
afterEach(() => { vi.restoreAllMocks(); for (const db of opened.splice(0)) db.close(); });

it("keeps the previous index and its insert trigger when backfilling fails", () => {
  const db = database();
  db.exec("CREATE TRIGGER fail_backfill BEFORE UPDATE ON messages BEGIN SELECT RAISE(FAIL, 'backfill refused'); END");
  expect(() => ensureSearchIndex(db, SPEC)).toThrow("backfill refused");
  expect(match(db, '"milk"')).toEqual(["en"]);
  db.prepare("INSERT INTO messages (id, text) VALUES (?, ?)").run("new", "Buy bread");
  expect(match(db, '"bread"')).toEqual(["new"]);
  db.exec("DROP TRIGGER fail_backfill");
  ensureSearchIndex(db, SPEC);
  expect(match(db, ftsPhrase("图书馆"))).toEqual(["zh"]);
  expect(match(db, '"bread"')).toEqual(["new"]);
});

it.each([true, false])("retries a failed rebuild instead of accepting an empty index (legacy=%s)", (legacy) => {
  const db = database(legacy);
  const exec = db.exec.bind(db);
  const intercept = vi.spyOn(db, "exec").mockImplementation((sql) => {
    if (sql.includes("VALUES ('rebuild')")) throw new Error("disk full while rebuilding");
    return exec(sql);
  });
  expect(() => ensureSearchIndex(db, SPEC)).toThrow("disk full while rebuilding");
  intercept.mockRestore();
  if (legacy) expect(match(db, '"milk"')).toEqual(["en"]);
  ensureSearchIndex(db, SPEC);
  expect(match(db, '"milk"')).toEqual(["en"]);
  expect(match(db, ftsPhrase("图书馆"))).toEqual(["zh"]);
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('integrity-check')");
});

it("keeps a successfully rebuilt index current across another open and later writes", () => {
  const db = database();
  ensureSearchIndex(db, SPEC);
  ensureSearchIndex(db, SPEC);
  db.prepare("INSERT INTO messages (id, text, search_text) VALUES (?, ?, ?)")
    .run("new", "明天去买咖啡", cjkSearchText("明天去买咖啡"));
  expect(match(db, ftsPhrase("咖啡"))).toEqual(["new"]);
  expect(match(db, '"milk"')).toEqual(["en"]);
});
