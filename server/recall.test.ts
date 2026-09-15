// Harness recall assembly (Phase 1 part 2): memory, the bot's other
// conversations (its rooms included, the current thread excluded), captures,
// and the recently section on a fresh session only.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { closeMessageDb, insertMessage } from "./message-db.ts";
import { buildRecall } from "./recall.ts";
import { Store, type Message } from "./store.ts";
import type { SupamausClient } from "./supamaus.ts";
import { ensureWorkspace, WORKSPACES_DIR } from "./workspace.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const msg = (id: string, text: string, extra: Partial<Message> = {}): Message => ({ id, role: "user", kind: "text", text, at: Date.now(), ...extra });

const found = [{ id: "CAP-1", at: Date.now(), app: "ChatGPT", title: "ChatGPT", text: "Fix the deploy password rotation" }];
const fresh = [{ id: "CAP-2", at: Date.now(), app: "Safari", title: "Linear", text: "" }];
const captures: SupamausClient = {
  enabled: () => true,
  search: async () => found,
  recent: async () => fresh,
  prime: () => {},
  searchNow: () => found,
  recentNow: () => fresh,
};

describe("buildRecall", () => {
  beforeEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    rmSync(WORKSPACES_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
  });

  it("numbers memory first, then other conversations with their titles, then captures; never the current thread", async () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const other = store.createTask(bot.id, "Deploy notes", false)!;
    const room = store.createGroup("Ops", [bot.id]);
    writeFileSync(join(ensureWorkspace(bot.id), "MEMORY.md"), "- 2026-09-01 · the deploy password hint is blue-falcon\n");
    insertMessage(other.threadId, msg("m1", "the deploy password rotates at noon", { role: "bot" }));
    insertMessage(room.threadId, msg("m2", "deploy password freeze on Fridays"));
    insertMessage(bot.threadId, msg("m3", "deploy deploy deploy in the current thread"));
    const block = (await buildRecall(store, { botId: bot.id, botName: "Scout", threadId: bot.threadId, query: "what is the deploy password hint", includeConversations: true, freshSession: false, captures }))!;
    expect(block.text).toContain("[1] MEMORY.md");
    expect(block.text).toContain("blue-falcon");
    expect(block.text).toContain('chat "Deploy notes"');
    expect(block.text).toContain('room "Ops"');
    expect(block.text).toContain("Scout: the deploy password rotates at noon");
    expect(block.text).toContain("User: deploy password freeze");
    expect(block.text).toContain('capture "ChatGPT"');
    expect(block.text).not.toContain("current thread");
    expect(block.counts).toEqual({ notes: 1, conversations: 2, captures: 1 });
    expect(block.text).not.toContain("What you were doing recently");
  });

  it("adds the recently section on a fresh session, from other threads' digests, the log and captures within the hour", async () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const other = store.createTask(bot.id, "Fix login", false)!;
    store.appendMessage(other.threadId, { role: "bot", kind: "digest", digest: { turnId: "t1", botId: bot.id, threadId: other.threadId, at: Date.now(), durationMs: 1, tools: [], memory: [], reply: "edited auth.ts", hookCoverage: "none" } } as any);
    const dir = ensureWorkspace(bot.id);
    mkdirSync(join(dir, "memory", "log"), { recursive: true });
    writeFileSync(join(dir, "memory", "log", "2026-09-15.md"), "- 10:00 · deployed v2\n- 11:00 · rollback discussed\n");
    const block = (await buildRecall(store, { botId: bot.id, botName: "Scout", threadId: bot.threadId, query: null, includeConversations: true, freshSession: true, captures }))!;
    expect(block.text).toContain("What you were doing recently");
    expect(block.text).toContain('chat "Fix login"');
    expect(block.text).toContain("edited auth.ts");
    expect(block.text).toContain("rollback discussed");
    expect(block.text).toContain('capture "Safari" (CAP-2)');
    expect(block.refs).toEqual([]);
    // and a resumed session with nothing to search gets nothing at all
    expect(await buildRecall(store, { botId: bot.id, botName: "Scout", threadId: bot.threadId, query: null, includeConversations: true, freshSession: false })).toBeNull();
  });

  it("ignores a note that shares only one common word with a long question", async () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const other = store.createTask(bot.id, "Chores", false)!;
    insertMessage(other.threadId, msg("m1", "please reply when the laundry is done", { role: "user" }));
    writeFileSync(join(ensureWorkspace(bot.id), "MEMORY.md"), "- 2026-09-01 · the person likes a warm reply\n");
    expect(await buildRecall(store, { botId: bot.id, botName: "Scout", threadId: bot.threadId, query: "Create a file called notes.txt and reply in one short sentence", includeConversations: true, freshSession: false })).toBeNull();
    // two shared terms is a match
    const block = await buildRecall(store, { botId: bot.id, botName: "Scout", threadId: bot.threadId, query: "is the laundry done, reply please", includeConversations: true, freshSession: false });
    expect(block?.text).toContain("laundry");
  });

  it("leaves other conversations out when asked (room turns) and survives a missing workspace", async () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const other = store.createTask(bot.id, "Deploy notes", false)!;
    insertMessage(other.threadId, msg("m1", "the deploy runs at noon", { role: "bot" }));
    expect(await buildRecall(store, { botId: bot.id, botName: "Scout", threadId: bot.threadId, query: "deploy", includeConversations: false, freshSession: false })).toBeNull();
    expect(await buildRecall(store, { botId: "ghost", botName: "Ghost", threadId: "none", query: "deploy", includeConversations: true, freshSession: true })).toBeNull();
  });
});
