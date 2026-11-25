import { readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { RESTART_EXIT_CODE } from "./restart.ts";
import { flushAtCleanExit, flushLaterSaves, SAVE_LATER_MAX_MS, waitingSaves } from "./save-batch.ts";
import { Store, type BotRecord } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const file = join(DATA_DIR, "bots.json");
const onDisk = (botId: string) => (JSON.parse(readFileSync(file, "utf8")) as BotRecord[]).find((bot) => bot.id === botId)!;
const written = () => statSync(file).ino;

describe("what bots.json holds, and when", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    vi.useFakeTimers();
  });
  afterEach(() => {
    flushLaterSaves();
    vi.useRealTimers();
  });

  /** What a turn's end writes that may wait: its usage, the context reading's model, and the turn's own unread mark. */
  function turnEnd(store: Store, botId: string, threadId: string): void {
    store.addTaskUsage(botId, threadId, { input: 100, output: 10, costUsd: null });
    store.patchTask(botId, threadId, { lastContextModel: "claude:claude-sonnet-5" });
    store.patchTask(botId, threadId, { unread: true }, { turnEnd: true });
  }

  it("writes the harmless end-of-turn changes once, a bounded moment later, however many turns end together", async () => {
    const store = new Store(selection);
    const bots = Array.from({ length: 6 }, (_, i) => store.createBot({ name: `Bot ${i}` }, { seedMessages: false }));
    const before = written();
    for (let n = 0; n < 3; n++) {
      for (const bot of bots) turnEnd(store, bot.id, bot.threadId);
      await vi.advanceTimersByTimeAsync(5);
      expect(written(), "nothing is written while the changes are still arriving").toBe(before);
    }
    expect(waitingSaves()).toBe(1);
    await vi.advanceTimersByTimeAsync(SAVE_LATER_MAX_MS);
    expect(waitingSaves()).toBe(0);
    expect(written()).not.toBe(before);
    for (const bot of bots) {
      const task = onDisk(bot.id).tasks!.find((candidate) => candidate.threadId === bot.threadId)!;
      expect(task).toMatchObject({ usage: { turns: 3 }, unread: true, lastContextModel: "claude:claude-sonnet-5" });
    }
    const once = written();
    await vi.advanceTimersByTimeAsync(10 * SAVE_LATER_MAX_MS);
    expect(written(), "one write for the lot").toBe(once);
  });

  it("holds everything else before the call returns, with the end-of-turn changes that were waiting", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Maus" }, { seedMessages: false }), threadId = bot.threadId;
    const task = (saved: BotRecord) => saved.tasks!.find((candidate) => candidate.threadId === threadId)!;
    const durable: Array<[string, () => void, (saved: BotRecord) => void]> = [
      ["an engine session", () => store.setResumeCursor(bot.id, "claude", { sessionId: "s-1" }, threadId),
        (saved) => expect(task(saved).resumeCursors).toEqual({ claude: { sessionId: "s-1" } })],
      ["which engine has the thread", () => store.markTaskDispatched(bot.id, threadId, "claude"), (saved) => expect(task(saved).lastInstanceId).toBe("claude")],
      ["what was handed to the engine", () => store.setHandedMessages(bot.id, threadId, "claude", { session: { sessionId: "s-1" }, lastMessageId: "m-1" } as never),
        (saved) => expect(task(saved).handedMessages).toMatchObject({ claude: { lastMessageId: "m-1" } })],
      ["a result posted into the chat (context changed elsewhere)", () => store.patchTask(bot.id, threadId, { resumeCursors: {}, lastInstanceId: "external:1" }),
        (saved) => expect(task(saved)).toMatchObject({ resumeCursors: {}, lastInstanceId: "external:1" })],
      ["a context reset", () => store.patchTask(bot.id, threadId, { resumeCursors: {} }), (saved) => expect(task(saved).resumeCursors).toEqual({})],
      ["when the person last wrote", () => store.setTaskAskedAt(bot.id, threadId, 5_000), (saved) => expect(task(saved).askedAt).toBe(5_000)],
      ["a read mark", () => store.patchTask(bot.id, threadId, { unread: false, lastReadMessageId: "m-9" }),
        (saved) => expect(task(saved)).toMatchObject({ unread: false, lastReadMessageId: "m-9" })],
      ["a person's own unread mark", () => store.patchTask(bot.id, threadId, { unread: true }), (saved) => expect(task(saved).unread).toBe(true)],
      ["a thread's title", () => store.patchTask(bot.id, threadId, { title: "Quarterly numbers" }), (saved) => expect(task(saved).title).toBe("Quarterly numbers")],
      ["an always-allow grant", () => store.patchTask(bot.id, threadId, { alwaysAllow: ["Bash(git status)"] }),
        (saved) => expect(task(saved).alwaysAllow).toEqual(["Bash(git status)"])],
      ["a new thread", () => store.createTask(bot.id, "Second thread", false), (saved) => expect(saved.tasks!.map((candidate) => candidate.title)).toContain("Second thread")],
      ["the bot's own settings", () => store.patchBot(bot.id, { name: "Renamed" }), (saved) => expect(saved.name).toBe("Renamed")],
    ];
    durable.forEach(([what, change, check], n) => {
      turnEnd(store, bot.id, threadId);
      expect(waitingSaves(), what).toBe(1);
      change();
      const saved = onDisk(bot.id);
      check(saved);
      expect(task(saved).usage, `${what}: the waiting changes ride along`).toMatchObject({ turns: n + 1 });
      const now = written();
      flushLaterSaves();
      expect(written(), `${what}: nothing is left waiting`).toBe(now);
    });
  });

  it("does not hold back the unread mark that wakes a snoozed thread", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Maus" }, { seedMessages: false });
    store.patchTask(bot.id, bot.threadId, { snoozedUntil: 0 });
    store.patchTask(bot.id, bot.threadId, { unread: true });
    const now = written();
    flushLaterSaves();
    expect(written(), "nothing of it was left waiting").toBe(now);
    const task = onDisk(bot.id).tasks!.find((candidate) => candidate.threadId === bot.threadId)!;
    expect(task.unread).toBe(true);
    expect(task.snoozedUntil).toBeUndefined();
  });

  it("writes what is waiting when flushed, as shutdown and a backup do, and at a clean exit but not after a fatal one", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Maus" }, { seedMessages: false });
    turnEnd(store, bot.id, bot.threadId);
    expect(onDisk(bot.id).tasks![0]!.usage).toBeUndefined();
    // 1: an uncaught exception; 70: the crash guard's fatal exit (server/crash-guard.ts).
    for (const fatal of [1, 70]) flushAtCleanExit(fatal);
    expect(onDisk(bot.id).tasks![0]!.usage, "a fatal exit leaves the last whole file").toBeUndefined();
    flushAtCleanExit(RESTART_EXIT_CODE);
    expect(onDisk(bot.id).tasks![0]).toMatchObject({ usage: { turns: 1 } });
    turnEnd(store, bot.id, bot.threadId);
    flushLaterSaves();
    expect(new Store(selection).taskByThread(bot.id, bot.threadId)?.usage?.turns).toBe(2);
  });

  it("names the changed thread on each bookkeeping event, so its frame can carry that thread alone", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Maus" }, { seedMessages: false });
    const second = store.createTask(bot.id, "Second thread")!;
    const events: unknown[] = [];
    store.onChange((change) => { if (change.type === "bot") events.push(change); });
    turnEnd(store, bot.id, second.threadId);
    store.setResumeCursor(bot.id, "claude", { sessionId: "s-1" }, second.threadId);
    store.setTaskAskedAt(bot.id, second.threadId, 1_000);
    store.setTaskActivity(bot.id, second.threadId, "working");
    expect(events.length).toBeGreaterThanOrEqual(6);
    for (const event of events) expect(event).toEqual({ type: "bot", botId: bot.id, threadId: second.threadId });
  });
});
