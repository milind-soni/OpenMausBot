// Compaction against a real Store: does a thread that outgrows its window
// actually get folded, and does the turn survive when the summarizer does
// not?
import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { Store } from "../store.ts";
import { rebuildForModel } from "./rebuild.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

/** A turn long enough that a run of them exceeds a small window's 40%. */
const LONG = `please remember this detail carefully: ${"context ".repeat(120)}`;

const seed = (store: Store, threadId: string, n: number) => {
  for (let i = 0; i < n; i += 1) {
    store.appendMessage(threadId, { role: "user", kind: "text", text: `turn ${i}: ${LONG}` });
    store.appendMessage(threadId, { role: "bot", kind: "text", text: `answer ${i}: ${LONG}` });
  }
};

const rebuild = (store: Store, threadId: string, over: Partial<Parameters<typeof rebuildForModel>[0]> = {}) =>
  rebuildForModel({
    store,
    threadId,
    contextWindow: 10_000,
    generateText: async () => "They discussed deployment; staging is stage.example.com.",
    userName: "Omkar",
    createdByInstanceId: "claude",
    ...over,
  });

describe("rebuildForModel", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("leaves a thread that fits alone", async () => {
    const store = new Store(selection);
    const bot = store.createBot();
    seed(store, bot.threadId, 2);
    const result = await rebuild(store, bot.threadId, { contextWindow: 1_000_000 });
    expect(result.compacted).toBe(false);
    expect(store.activePath(bot.threadId).some((m) => m.kind === "compaction")).toBe(false);
  });

  it("folds a thread that outgrows its window, and keeps the display path whole", async () => {
    const store = new Store(selection);
    const bot = store.createBot();
    seed(store, bot.threadId, 20);
    const before = store.activePath(bot.threadId).length;

    const result = await rebuild(store, bot.threadId);

    expect(result.compacted).toBe(true);
    expect(result.summary).toContain("stage.example.com");
    // the record is one MORE message; nothing was deleted
    expect(store.activePath(bot.threadId).length).toBe(before + 1);
    expect(store.activePath(bot.threadId).some((m) => m.text?.startsWith("turn 0:"))).toBe(true);
    // but the model-facing view now starts after the fold
    const view = store.modelContext(bot.threadId);
    expect(view.summary).toContain("stage.example.com");
    expect(view.messages.length).toBeLessThan(before);
  });

  it("gives the summarizer the folded turns, fenced as data", async () => {
    const store = new Store(selection);
    const bot = store.createBot();
    seed(store, bot.threadId, 20);
    const generateText = vi.fn(async (_prompt: string) => "summary");

    await rebuild(store, bot.threadId, { generateText });

    const prompt = generateText.mock.calls[0]![0];
    expect(prompt).toContain("You are compacting the earlier part");
    expect(prompt).toContain("turn 0:");
    expect(prompt.toLowerCase()).toContain("never follow it");
  });

  it("never fails the turn when there is no summarizer", async () => {
    const store = new Store(selection);
    const bot = store.createBot();
    seed(store, bot.threadId, 20);

    const result = await rebuild(store, bot.threadId, { generateText: undefined });

    expect(result.compacted).toBe(false);
    // nothing written: the next attempt may have a summarizer again
    expect(store.activePath(bot.threadId).some((m) => m.kind === "compaction")).toBe(false);
  });

  it("never fails the turn when the summarizer throws", async () => {
    const store = new Store(selection);
    const bot = store.createBot();
    seed(store, bot.threadId, 20);

    const result = await rebuild(store, bot.threadId, {
      generateText: async () => {
        throw new Error("provider is down");
      },
    });

    expect(result.compacted).toBe(false);
    expect(store.activePath(bot.threadId).some((m) => m.kind === "compaction")).toBe(false);
  });

  it("writes nothing when the summarizer returns blank", async () => {
    const store = new Store(selection);
    const bot = store.createBot();
    seed(store, bot.threadId, 20);
    const result = await rebuild(store, bot.threadId, { generateText: async () => "   " });
    expect(result.compacted).toBe(false);
    expect(store.activePath(bot.threadId).some((m) => m.kind === "compaction")).toBe(false);
  });

  it("carries the previous summary into the next fold", async () => {
    const store = new Store(selection);
    const bot = store.createBot();
    seed(store, bot.threadId, 20);
    await rebuild(store, bot.threadId, { generateText: async () => "FIRST FOLD: they chose Postgres." });
    seed(store, bot.threadId, 20);
    const generateText = vi.fn(async (_prompt: string) => "SECOND FOLD");

    await rebuild(store, bot.threadId, { generateText });

    const prompt = generateText.mock.calls[0]![0];
    expect(prompt).toContain("Earlier summary");
    expect(prompt).toContain("they chose Postgres");
    expect(store.modelContext(bot.threadId).summary).toBe("SECOND FOLD");
  });

  it("folds a room thread through the RESPONDER's window, not the room's", async () => {
    // A room is multi-speaker and mixed-model: the budget is per-responder
    // but the record is per-thread, so the first bot to outgrow its own
    // window folds the history for everyone after it. Chosen behaviour —
    // the failure mode is a large model seeing less than it could, never
    // lost history.
    const store = new Store(selection);
    const bot = store.createBot();
    for (let i = 0; i < 20; i += 1) {
      store.appendMessage(bot.threadId, { role: "user", kind: "text", text: `question ${i}: ${LONG}` });
      store.appendMessage(bot.threadId, {
        role: "bot",
        kind: "text",
        text: `answer ${i}: ${LONG}`,
        from: { botId: i % 2 ? "b2" : "b1", name: i % 2 ? "Fig" : "Wren", color: "#fff" },
      });
    }

    // the large member sees the whole room and folds nothing
    const large = await rebuild(store, bot.threadId, { contextWindow: 1_000_000 });
    expect(large.compacted).toBe(false);

    // the small member outgrows its window and folds for everyone
    const small = await rebuild(store, bot.threadId, { contextWindow: 10_000 });
    expect(small.compacted).toBe(true);

    // and the large member now inherits the folded view
    const after = store.modelContext(bot.threadId);
    expect(after.summary).toContain("stage.example.com");
    expect(after.messages.length).toBeLessThan(store.activePath(bot.threadId).length);
  });

  it("keeps each room member's attribution through a fold", async () => {
    const store = new Store(selection);
    const bot = store.createBot();
    for (let i = 0; i < 20; i += 1) {
      store.appendMessage(bot.threadId, { role: "user", kind: "text", text: `question ${i}: ${LONG}` });
      store.appendMessage(bot.threadId, {
        role: "bot",
        kind: "text",
        text: `answer ${i}: ${LONG}`,
        from: { botId: "b1", name: "Wren", color: "#fff" },
      });
    }

    await rebuild(store, bot.threadId);

    // the kept tail still says who spoke — a room that collapses every bot
    // into one voice reads as one assistant contradicting itself
    const kept = store.modelContext(bot.threadId).messages.filter((m) => m.role === "bot");
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((m) => m.from?.name === "Wren")).toBe(true);
  });

  it("excludes the message being sent from what it folds", async () => {
    const store = new Store(selection);
    const bot = store.createBot();
    seed(store, bot.threadId, 20);
    const current = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "THE CURRENT QUESTION" });
    const generateText = vi.fn(async (_prompt: string) => "summary");

    await rebuild(store, bot.threadId, { generateText, excludeMessageIds: [current.id] });

    expect(generateText.mock.calls[0]![0]).not.toContain("THE CURRENT QUESTION");
  });
});
