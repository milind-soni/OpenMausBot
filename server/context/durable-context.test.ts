// The compaction record as a durable row: what survives a restart, what
// must never leak into search, and what an older build does with a kind it
// has never heard of.
import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import * as mdb from "../message-db.ts";
import { Store, type CompactionRecord, type Message } from "../store.ts";
import { sanitizeToolObservation } from "./sanitize.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

const record = (over: Partial<CompactionRecord> = {}): CompactionRecord => ({
  schemaVersion: 1,
  summary: "The user is deploying to Vercel. Their staging URL is stage.example.com.",
  firstKeptId: "m10",
  throughId: "m9",
  estimatedTokensBefore: 12_000,
  targetContextWindow: 8_000,
  createdByInstanceId: "claude",
  ...over,
});

describe("durable compaction records", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("round-trips through SQLite unchanged", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const compaction = record();

    const written = store.appendMessage(bot.threadId, { role: "bot", kind: "compaction", compaction });

    const reopened = new Store(selection);
    const read = reopened.messagesFor(bot.threadId).find((m) => m.id === written.id);
    expect(read?.kind).toBe("compaction");
    expect(read?.compaction).toEqual(compaction);
  });

  it("stays out of full-text search, summary and all", () => {
    // The summary carries whatever the conversation carried — URLs, paths,
    // decisions. Search spans every kind by row, so the ONLY thing keeping
    // it out is that the summary lives in the json blob with `text` null.
    const store = new Store(selection);
    const bot = store.createBot();
    store.appendMessage(bot.threadId, { role: "bot", kind: "compaction", compaction: record() });
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "deploying to Vercel now" });

    const hits = mdb.searchMessages("Vercel", 40, bot.threadId);
    expect(hits.map((h) => h.kind)).toEqual(["text"]);
    expect(hits.some((h) => h.snippet.includes("stage.example.com"))).toBe(false);
  });

  it("keeps `text` empty on a compaction row, which is what the search rule rests on", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const written = store.appendMessage(bot.threadId, { role: "bot", kind: "compaction", compaction: record() });
    expect(written.text).toBeUndefined();
  });

  it("leaves the visible history above it completely intact", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const before = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "the old turn" });
    const target = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "the kept turn" });

    store.appendCompaction(bot.threadId, record({ firstKeptId: target.id }));

    const path = new Store(selection).activePath(bot.threadId);
    expect(path.map((m) => m.text)).toContain("the old turn");
    expect(path.find((m) => m.id === before.id)).toBeDefined();
    expect(path.map((m) => m.kind)).toContain("compaction");
  });
});

describe("tool observations on a message", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("persists a bounded snapshot alongside the existing tool chip", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const context = sanitizeToolObservation({
      name: "Edit",
      input: "server/store.ts",
      output: "1 file changed",
      ok: true,
      filesModified: ["server/store.ts"],
    });

    const written = store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "activity",
      tool: { name: "tool: Edit", ok: true, context },
    });

    const read = new Store(selection).messagesFor(bot.threadId).find((m) => m.id === written.id);
    expect(read?.tool?.name).toBe("tool: Edit");
    expect(read?.tool?.context).toEqual(context);
  });

  it("does not make tool output searchable — search matches the chip name only", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "activity",
      tool: {
        name: "tool: Bash",
        ok: true,
        context: sanitizeToolObservation({ name: "Bash", output: "listening on stage.example.com" }),
      },
    });
    expect(mdb.searchMessages("stage.example.com", 40, bot.threadId)).toHaveLength(0);
    expect(mdb.searchMessages("Bash", 40, bot.threadId)).toHaveLength(1);
  });
});

describe("a kind this build has never heard of", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("loads and stays on the branch instead of breaking the thread", () => {
    // Compaction rows are written once and read forever, including by a
    // build the user downgraded to. Reading must never be what breaks.
    const store = new Store(selection);
    const bot = store.createBot();
    const anchor = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hello" });
    const alien = {
      id: "from-the-future",
      at: Date.now(),
      role: "bot",
      kind: "some-future-kind",
      parentId: anchor.id,
    } as unknown as Message;
    mdb.insertMessage(bot.threadId, alien);
    mdb.setActiveLeaf(bot.threadId, alien.id);

    const reopened = new Store(selection);
    expect(() => reopened.activePath(bot.threadId)).not.toThrow();
    const path = reopened.activePath(bot.threadId);
    expect(path.at(-1)?.id).toBe("from-the-future");
    expect(path.map((m) => m.text)).toContain("hello");
  });
});
