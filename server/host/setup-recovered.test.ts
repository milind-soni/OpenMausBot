import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { peerStatus, peerStatusWords } from "../peer-roster.ts";
import { Store } from "../store.ts";
import { clearSetupFailures } from "./setup-recovered.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const roster = (store: Store, botId: string) => peerStatusWords(peerStatus(store.bot(botId)?.activity, store.bot(botId)?.busy));

describe("a bot whose setup failed once", () => {
  beforeEach(() => { rmSync(DATA_DIR, { recursive: true, force: true }); });

  it("reads as available again once another of its turns succeeds, not until the failed conversation runs again", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const failed = store.createTask(bot.id, "signed out")!;
    const later = store.createTask(bot.id, "later")!;
    // Its engine's sign-in had expired in one conversation (server/index.ts marks it "dead").
    store.setTaskActivity(bot.id, failed.threadId, "dead");
    expect(roster(store, bot.id)).toBe("unavailable — needs setup");
    // The person signs in again and another conversation of the same bot works.
    store.setTaskActivity(bot.id, later.threadId, "working");
    store.setTaskActivity(bot.id, later.threadId, "idle");
    expect(roster(store, bot.id)).toBe("unavailable — needs setup");
    clearSetupFailures(store, bot.id, later.threadId);
    expect(roster(store, bot.id)).toBe("available");
    expect(store.taskByThread(bot.id, failed.threadId)?.activity).toBe("idle");
  });

  it("keeps a conversation on another engine marked: a turn that works on one engine says nothing of another's sign-in", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const other = store.createTask(bot.id, "other engine", true, undefined, undefined, undefined, { instanceId: "codex", model: "gpt-5" })!;
    const same = store.createTask(bot.id, "same engine")!;
    store.setTaskActivity(bot.id, other.threadId, "dead");
    clearSetupFailures(store, bot.id, same.threadId);
    expect(store.taskByThread(bot.id, other.threadId)?.activity).toBe("dead");
    expect(roster(store, bot.id)).toBe("unavailable — needs setup");
  });

  it("goes by the engine each conversation last ran on: a turn a stand-in engine carried clears nothing on the signed-out one", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const failed = store.createTask(bot.id, "signed out")!;
    const carried = store.createTask(bot.id, "carried by a stand-in")!;
    store.markTaskDispatched(bot.id, failed.threadId, "claude");
    store.setTaskActivity(bot.id, failed.threadId, "dead");
    store.markTaskDispatched(bot.id, carried.threadId, "codex");
    clearSetupFailures(store, bot.id, carried.threadId);
    expect(store.taskByThread(bot.id, failed.threadId)?.activity).toBe("dead");
    store.markTaskDispatched(bot.id, carried.threadId, "claude");
    clearSetupFailures(store, bot.id, carried.threadId);
    expect(store.taskByThread(bot.id, failed.threadId)?.activity).toBe("idle");
  });

  it("leaves other activities as they are", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const waiting = store.createTask(bot.id, "asks")!;
    store.setTaskActivity(bot.id, waiting.threadId, "waiting-on-you");
    clearSetupFailures(store, bot.id, waiting.threadId);
    expect(store.taskByThread(bot.id, waiting.threadId)?.activity).toBe("waiting-on-you");
    clearSetupFailures(store, "no-such-bot", waiting.threadId);
  });
});
