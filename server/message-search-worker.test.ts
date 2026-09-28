import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeMessageDb, closeMessageSearch, deleteThread, insertMessage, searchMessages, searchMessagesAsync } from "./message-db.ts";
import { MessageSearchWorker } from "./message-search-worker.ts";

beforeEach(async () => {
  await closeMessageSearch();
  closeMessageDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  insertMessage("a", { id: "m1", at: 1, role: "user", kind: "text", text: "Literal 10%_\\ path. Hello 世界. " + "long ".repeat(100) + "needle" });
  insertMessage("b", { id: "m2", at: 2, role: "bot", kind: "activity", tool: { name: "Run HELLO migration", ok: true } });
});
afterEach(async () => { await closeMessageSearch(); closeMessageDb(); });

it("preserves literal search, tool names, snippets, order, limits and thread scope", async () => {
  for (const query of ["hello", "10%_\\", "世界", "needle", "absent", "  "]) {
    for (const thread of [undefined, "a", "b", "missing"]) {
      expect(await searchMessagesAsync(query, 1, thread)).toEqual(searchMessages(query, 1, thread));
    }
  }
});

it("sees committed writes and deletions without restarting the worker", async () => {
  expect(await searchMessagesAsync("newly committed")).toEqual([]);
  insertMessage("a", { id: "new", at: 3, role: "user", kind: "text", text: "newly committed" });
  expect(await searchMessagesAsync("newly committed")).toMatchObject([{ threadId: "a", messageId: "new" }]);
  deleteThread("a");
  expect(await searchMessagesAsync("newly committed")).toEqual([]);
});

it("bounds outstanding scans and releases capacity after completion", async () => {
  const pending = Array.from({ length: 8 }, () => searchMessagesAsync("hello"));
  await expect(searchMessagesAsync("hello")).rejects.toMatchObject({ status: 503 });
  expect((await Promise.all(pending)).every(hits => hits.length === 2)).toBe(true);
  expect(await searchMessagesAsync("hello")).toHaveLength(2);
});

it("interrupts pending scans before maintenance and reopens against the new data", async () => {
  const pending = expect(searchMessagesAsync("hello")).rejects.toMatchObject({ status: 503 });
  await closeMessageSearch();
  await pending;
  closeMessageDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  insertMessage("replacement", { id: "m", at: 1, role: "user", kind: "text", text: "hello replacement" });
  expect(await searchMessagesAsync("hello")).toMatchObject([{ threadId: "replacement" }]);
});

it("opens read-only, fails safely, and never creates a missing database", async () => {
  const file = join(DATA_DIR, "missing.sqlite"), worker = new MessageSearchWorker(file);
  try {
    await expect(worker.search("private-query", 40)).rejects.toMatchObject({ message: "Search could not finish. Try again shortly.", status: 503 });
    expect(existsSync(file)).toBe(false);
  } finally { await worker.close(); }
});

it("bounds a stuck worker's lifetime and rejects all waiting requests", async () => {
  // A fresh worker cannot import/open SQLite before this short deadline.
  const worker = new MessageSearchWorker(join(DATA_DIR, "messages.db"), 1);
  try {
    const results = await Promise.allSettled([worker.search("hello", 40), worker.search("hello", 40)]);
    expect(results.every(result => result.status === "rejected" && result.reason.status === 503)).toBe(true);
  } finally { await worker.close(); }
});
