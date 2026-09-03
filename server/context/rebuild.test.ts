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
    const generateText = vi.fn(async () => "summary");

    await rebuild(store, bot.threadId, { generateText });

    const prompt = generateText.mock.calls[0]?.[0] as string;
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
    const generateText = vi.fn(async () => "SECOND FOLD");

    await rebuild(store, bot.threadId, { generateText });

    const prompt = generateText.mock.calls[0]?.[0] as string;
    expect(prompt).toContain("Earlier summary");
    expect(prompt).toContain("they chose Postgres");
    expect(store.modelContext(bot.threadId).summary).toBe("SECOND FOLD");
  });

  it("excludes the message being sent from what it folds", async () => {
    const store = new Store(selection);
    const bot = store.createBot();
    seed(store, bot.threadId, 20);
    const current = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "THE CURRENT QUESTION" });
    const generateText = vi.fn(async () => "summary");

    await rebuild(store, bot.threadId, { generateText, excludeMessageIds: [current.id] });

    expect(generateText.mock.calls[0]?.[0] as string).not.toContain("THE CURRENT QUESTION");
  });
});
