import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { peerStatus, peerStatusWords } from "../peer-roster.ts";
import { Store } from "../store.ts";
import { createSetupRecovery } from "./setup-recovered.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const roster = (store: Store, botId: string) => peerStatusWords(peerStatus(store.bot(botId)?.activity, store.bot(botId)?.busy));
const ENGINE_TURN = { replayed: false, stopped: false };

/** A bot with a conversation that failed setup and another whose turn is running; `clock` is when marks are made. */
function setup(options: { failedEngine?: ModelSelection } = {}) {
  const store = new Store(selection);
  const bot = store.createBot();
  const failed = store.createTask(bot.id, "signed out", true, undefined, undefined, undefined, options.failedEngine)!;
  const later = store.createTask(bot.id, "later")!;
  let clock = 0;
  const recovery = createSetupRecovery(store, () => clock);
  const markFailed = () => {
    store.setTaskActivity(bot.id, failed.threadId, "dead");
    recovery.failed(bot.id, failed.threadId);
  };
  const startLater = () => {
    store.setTaskActivity(bot.id, later.threadId, "working");
    return store.taskByThread(bot.id, later.threadId)!.turnStartedAt!;
  };
  const activity = () => store.taskByThread(bot.id, failed.threadId)?.activity;
  return { store, bot, failed, later, recovery, markFailed, startLater, activity, at: (time: number) => { clock = time; } };
}

describe("a bot whose setup failed once", () => {
  beforeEach(() => { rmSync(DATA_DIR, { recursive: true, force: true }); });

  it("reads as available again once a turn its engine answered succeeds, not only when the failed conversation runs again", () => {
    const { store, bot, later, recovery, markFailed, startLater, activity, at } = setup();
    at(1);
    markFailed();
    expect(roster(store, bot.id)).toBe("unavailable — needs setup");
    startLater();
    recovery.succeeded(bot.id, later.threadId, ENGINE_TURN);
    expect(activity()).toBe("idle");
    expect(roster(store, bot.id)).not.toBe("unavailable — needs setup");
  });

  it("keeps a mark made after the succeeding turn started: that turn began before the sign-in lapsed", () => {
    const { bot, later, recovery, markFailed, startLater, activity, at } = setup();
    const startedAt = startLater();
    at(startedAt + 60_000);
    markFailed();
    recovery.succeeded(bot.id, later.threadId, ENGINE_TURN);
    expect(activity()).toBe("dead");
  });

  it("keeps the mark for a turn saved steps answered with no engine call, and for a turn the person stopped", () => {
    const { bot, later, recovery, markFailed, startLater, activity, at } = setup();
    at(1);
    markFailed();
    startLater();
    recovery.succeeded(bot.id, later.threadId, { replayed: true, stopped: false });
    expect(activity()).toBe("dead");
    recovery.succeeded(bot.id, later.threadId, { replayed: false, stopped: true });
    expect(activity()).toBe("dead");
  });

  it("keeps the mark when the succeeding turn never ran as a turn (no start time)", () => {
    const { bot, later, recovery, markFailed, activity, at } = setup();
    at(1);
    markFailed();
    recovery.succeeded(bot.id, later.threadId, ENGINE_TURN);
    expect(activity()).toBe("dead");
  });

  it("keeps a conversation set to another engine marked", () => {
    const { bot, later, recovery, markFailed, startLater, activity, at } = setup({ failedEngine: { instanceId: "codex", model: "gpt-5" } });
    at(1);
    markFailed();
    startLater();
    recovery.succeeded(bot.id, later.threadId, ENGINE_TURN);
    expect(activity()).toBe("dead");
  });

  it("goes by the engine each conversation last ran on: a stand-in engine's success clears nothing on the signed-out one", () => {
    const { store, bot, failed, later, recovery, markFailed, startLater, activity, at } = setup();
    at(1);
    store.markTaskDispatched(bot.id, failed.threadId, "claude");
    markFailed();
    startLater();
    store.markTaskDispatched(bot.id, later.threadId, "codex");
    recovery.succeeded(bot.id, later.threadId, ENGINE_TURN);
    expect(activity()).toBe("dead");
    store.markTaskDispatched(bot.id, later.threadId, "claude");
    recovery.succeeded(bot.id, later.threadId, ENGINE_TURN);
    expect(activity()).toBe("idle");
  });

  it("reads a conversation carried in from elsewhere (no engine yet) as on the engine it is set to", () => {
    const { store, bot, failed, later, recovery, markFailed, startLater, activity, at } = setup();
    at(1);
    store.markTaskDispatched(bot.id, failed.threadId, "__openmaus_external_context__:4f1c");
    markFailed();
    startLater();
    store.markTaskDispatched(bot.id, later.threadId, "claude");
    recovery.succeeded(bot.id, later.threadId, ENGINE_TURN);
    expect(activity()).toBe("idle");
  });

  it("leaves other activities as they are, and ignores a bot or conversation it does not know", () => {
    const { store, bot, later, recovery, startLater } = setup();
    const waiting = store.createTask(bot.id, "asks")!;
    store.setTaskActivity(bot.id, waiting.threadId, "waiting-on-you");
    startLater();
    recovery.succeeded(bot.id, later.threadId, ENGINE_TURN);
    expect(store.taskByThread(bot.id, waiting.threadId)?.activity).toBe("waiting-on-you");
    recovery.succeeded("no-such-bot", later.threadId, ENGINE_TURN);
    recovery.succeeded(bot.id, "no-such-thread", ENGINE_TURN);
  });
});
