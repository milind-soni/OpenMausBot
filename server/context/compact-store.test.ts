// Compaction records in the tree, and the model-facing view they produce.
// Ported from the original pi.dev-derived tests (commit 3374576).
import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { Store, type CompactionRecord } from "../store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

const record = (over: Partial<CompactionRecord> & Pick<CompactionRecord, "summary" | "firstKeptId">): CompactionRecord => ({
  schemaVersion: 1,
  throughId: "unset",
  estimatedTokensBefore: 999,
  targetContextWindow: 200_000,
  createdByInstanceId: "claude",
  ...over,
});

const seed = (store: Store, threadId: string, n: number) => {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    ids.push(store.appendMessage(threadId, { role: i % 2 ? "bot" : "user", kind: "text", text: `m${i}` }).id);
  }
  return ids;
};

describe("Store compaction records", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("modelContext is the whole active path when nothing was compacted", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    seed(store, bot.threadId, 4);
    const ctx = store.modelContext(bot.threadId);
    expect(ctx.summary).toBeUndefined();
    expect(ctx.messages.length).toBe(store.activePath(bot.threadId).length);
  });

  it("a record lives in the tree, keeps everything behind it, and the view starts at firstKeptId", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const ids = seed(store, bot.threadId, 6);

    const written = store.appendCompaction(bot.threadId, record({ summary: "they discussed m0..m2", firstKeptId: ids[3] }));

    expect(written.kind).toBe("compaction");
    // nothing deleted: the display path still reaches message one
    expect(store.activePath(bot.threadId).some((m) => m.text === "m0")).toBe(true);
    const ctx = store.modelContext(bot.threadId);
    expect(ctx.summary).toBe("they discussed m0..m2");
    expect(ctx.messages.map((m) => m.text)).toEqual(["m3", "m4", "m5"]);
    // later messages descend from the record
    const later = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "m6" });
    expect(later.parentId).toBe(written.id);
    expect(store.modelContext(bot.threadId).messages.map((m) => m.text)).toEqual(["m3", "m4", "m5", "m6"]);
  });

  it("the latest compaction wins, and a rewind to before it ignores it", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const ids = seed(store, bot.threadId, 6);
    store.appendCompaction(bot.threadId, record({ summary: "first", firstKeptId: ids[2] }));
    seed(store, bot.threadId, 2);
    store.appendCompaction(bot.threadId, record({ summary: "second", firstKeptId: ids[5] }));
    expect(store.modelContext(bot.threadId).summary).toBe("second");

    // setActiveLeaf descends to the newest leaf, which is past both records;
    // a real rewind is an edit, which forks a branch the records are not on
    const fork = store.branchMessage(bot.threadId, ids[4], "edited m4")!;

    expect(fork).toBeTruthy();
    const ctx = store.modelContext(bot.threadId);
    expect(ctx.summary).toBeUndefined();
    expect(ctx.messages.map((m) => m.text)).toContain("edited m4");
  });

  it("survives a restart", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const ids = seed(store, bot.threadId, 6);
    store.appendCompaction(bot.threadId, record({ summary: "folded away", firstKeptId: ids[3] }));

    const reopened = new Store(selection);
    expect(reopened.modelContext(bot.threadId).summary).toBe("folded away");
    expect(reopened.modelContext(bot.threadId).messages.map((m) => m.text)).toEqual(["m3", "m4", "m5"]);
  });

  it("falls back to the messages after the record when the boundary moved away", () => {
    // the branch changed while the summary was being written: the record is
    // still honoured, it just cannot point behind itself any more
    const store = new Store(selection);
    const bot = store.createBot();
    seed(store, bot.threadId, 4);
    store.appendCompaction(bot.threadId, record({ summary: "s", firstKeptId: "no-such-id" }));
    seed(store, bot.threadId, 2);

    const ctx = store.modelContext(bot.threadId);
    expect(ctx.summary).toBe("s");
    expect(ctx.messages.map((m) => m.text)).toEqual(["m0", "m1"]);
  });

  it("never shows a record to the model as a message of its own", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const ids = seed(store, bot.threadId, 6);
    store.appendCompaction(bot.threadId, record({ summary: "s", firstKeptId: ids[3] }));
    expect(store.modelContext(bot.threadId).messages.some((m) => m.kind === "compaction")).toBe(false);
  });
});
