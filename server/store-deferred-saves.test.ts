import { readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { flushLaterSaves, SAVE_LATER_MAX_MS, waitingSaves } from "./save-batch.ts";
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

  /** Everything one turn writes about itself, as server/index.ts does from start to settle. */
  function turn(store: Store, botId: string, threadId: string, n: number): void {
    store.setTaskAskedAt(botId, threadId, 1_000 + n);
    store.markTaskDispatched(botId, threadId, "claude");
    store.patchTask(botId, threadId, { unread: false });
    store.setResumeCursor(botId, "claude", { sessionId: `s-${n}` }, threadId);
    store.setHandedMessages(botId, threadId, "claude", { session: { sessionId: `s-${n}` }, lastMessageId: `m-${n}` } as never);
    store.addTaskUsage(botId, threadId, { input: 100, output: 10, costUsd: null });
    store.patchTask(botId, threadId, { lastContextModel: "claude:claude-sonnet-5" });
    store.patchTask(botId, threadId, { unread: true });
  }

  it("writes a turn's own bookkeeping once, a bounded moment later, however many turns run together", async () => {
    const store = new Store(selection);
    const bots = Array.from({ length: 6 }, (_, i) => store.createBot({ name: `Bot ${i}` }, { seedMessages: false }));
    const before = written();
    for (let n = 0; n < 3; n++) {
      for (const bot of bots) turn(store, bot.id, bot.threadId, n);
      await vi.advanceTimersByTimeAsync(5);
      expect(written(), "nothing is written while the changes are still arriving").toBe(before);
    }
    expect(waitingSaves()).toBe(1);
    await vi.advanceTimersByTimeAsync(SAVE_LATER_MAX_MS);
    expect(waitingSaves()).toBe(0);
    expect(written()).not.toBe(before);
    for (const bot of bots) {
      const task = onDisk(bot.id).tasks!.find((candidate) => candidate.threadId === bot.threadId)!;
      expect(task).toMatchObject({ resumeCursors: { claude: { sessionId: "s-2" } }, usage: { turns: 3 }, unread: true, askedAt: 1_002, lastInstanceId: "claude" });
    }
    const once = written();
    await vi.advanceTimersByTimeAsync(10 * SAVE_LATER_MAX_MS);
    expect(written(), "one write for the lot").toBe(once);
  });

  it("holds what a person or a bot asked for before the call returns, with the bookkeeping that was waiting", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Maus" }, { seedMessages: false }), threadId = bot.threadId;
    const durable: Array<[string, () => void, (saved: BotRecord) => void]> = [
      ["a thread's title", () => store.patchTask(bot.id, threadId, { title: "Quarterly numbers" }),
        (saved) => expect(saved.tasks!.find((task) => task.threadId === threadId)!.title).toBe("Quarterly numbers")],
      ["an always-allow grant", () => store.patchTask(bot.id, threadId, { alwaysAllow: ["Bash(git status)"] }),
        (saved) => expect(saved.tasks!.find((task) => task.threadId === threadId)!.alwaysAllow).toEqual(["Bash(git status)"])],
      ["a new thread", () => store.createTask(bot.id, "Second thread", false),
        (saved) => expect(saved.tasks!.map((task) => task.title)).toContain("Second thread")],
      ["the bot's own settings", () => store.patchBot(bot.id, { name: "Renamed" }),
        (saved) => expect(saved.name).toBe("Renamed")],
    ];
    durable.forEach(([what, change, check], n) => {
      turn(store, bot.id, threadId, n);
      expect(waitingSaves(), what).toBe(1);
      change();
      const saved = onDisk(bot.id);
      check(saved);
      expect(saved.tasks!.find((task) => task.threadId === threadId), `${what}: the bookkeeping rides along`)
        .toMatchObject({ resumeCursors: { claude: { sessionId: `s-${n}` } }, usage: { turns: n + 1 } });
      expect(waitingSaves(), `${what}: nothing is left waiting`).toBe(0);
    });
  });

  it("does not hold back the unread mark that wakes a snoozed thread", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Maus" }, { seedMessages: false });
    store.patchTask(bot.id, bot.threadId, { snoozedUntil: 0 });
    store.patchTask(bot.id, bot.threadId, { unread: true });
    expect(waitingSaves()).toBe(0);
    const task = onDisk(bot.id).tasks!.find((candidate) => candidate.threadId === bot.threadId)!;
    expect(task.unread).toBe(true);
    expect(task.snoozedUntil).toBeUndefined();
  });

  it("writes what is waiting when flushed, as shutdown and a backup do", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Maus" }, { seedMessages: false });
    turn(store, bot.id, bot.threadId, 7);
    expect(onDisk(bot.id).tasks![0]!.usage).toBeUndefined();
    flushLaterSaves();
    expect(onDisk(bot.id).tasks![0]).toMatchObject({ usage: { turns: 1 }, resumeCursors: { claude: { sessionId: "s-7" } } });
    expect(new Store(selection).taskByThread(bot.id, bot.threadId)?.usage?.turns).toBe(1);
  });

  it("names the changed thread on each bookkeeping event, so its frame can carry that thread alone", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Maus" }, { seedMessages: false });
    const second = store.createTask(bot.id, "Second thread")!;
    const events: unknown[] = [];
    store.onChange((change) => { if (change.type === "bot") events.push(change); });
    turn(store, bot.id, second.threadId, 1);
    store.setTaskActivity(bot.id, second.threadId, "working");
    expect(events.length).toBeGreaterThanOrEqual(6);
    for (const event of events) expect(event).toEqual({ type: "bot", botId: bot.id, threadId: second.threadId });
  });
});
