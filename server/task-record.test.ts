import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { approvalModeFor } from "../shared/approval-mode.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { Store } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const REQUEST = "123e4567-e89b-42d3-a456-426614174000";
const levelOf = (store: Store, botId: string, threadId: string) => approvalModeFor(store.projectBotForTask(botId, threadId)!);

// A thread a bot opens for itself or is handed (start_thread, a hand-off, a burst, a routine run) is made with createTask
// while the person may be changing a level in the desktop app: it must start at the bot's own level, never at the Ask
// mask a pending grant shows.
describe("a thread a bot opens while a level change is being confirmed", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it.each(["prepared", "confirmed", "activated", "committed"] as const)(
    "starts at the bot's Full access while the open chat's own grant is in phase %s", (phase) => {
      const store = new Store(selection);
      const bot = store.createBot();
      store.patchBot(bot.id, { approvalMode: "full", autoApprove: false });
      // The person picks Custom in the composer of the chat on screen; the desktop is still confirming it.
      store.patchBot(bot.id, { approvalGrant: { requestId: REQUEST, mode: "custom", phase, threadId: bot.threadId, threadOnly: true } });

      const spawned = store.createTask(bot.id, "Research", false)!;

      expect(levelOf(store, bot.id, spawned.threadId)).toBe("full");
      expect(store.taskByThread(bot.id, spawned.threadId)?.approvalMode).toBe("full");
      // The grant ends (confirmed or not): the new thread still runs at the bot's level.
      store.patchBot(bot.id, { approvalGrant: undefined });
      expect(levelOf(store, bot.id, spawned.threadId)).toBe("full");
      expect(levelOf(new Store(selection), bot.id, spawned.threadId)).toBe("full");
    });

  it("starts at the default Full access on a bot nobody set a level on, while the open chat's grant is pending", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { approvalGrant: { requestId: REQUEST, mode: "full", phase: "prepared", threadId: bot.threadId, threadOnly: true } });

    const spawned = store.createTask(bot.id, "Handed on", false)!;

    expect(levelOf(store, bot.id, spawned.threadId)).toBe("full");
  });

  it("follows the bot once a bot-wide Full access grant commits, and Ask if it rolls back", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { approvalMode: "ask", autoApprove: false });
    // Bot settings → Full access, still being confirmed: the bot record already says Full, masked as Ask.
    store.patchBot(bot.id, { approvalMode: "full", approvalGrant: { requestId: REQUEST, mode: "full", phase: "activated" } });

    const committed = store.createTask(bot.id, "Made while confirming", false)!;
    // Never Full ahead of the confirmation.
    expect(levelOf(store, bot.id, committed.threadId)).toBe("ask");
    store.patchBot(bot.id, { approvalGrant: undefined });
    expect(levelOf(store, bot.id, committed.threadId)).toBe("full");

    store.patchBot(bot.id, { approvalMode: "full", approvalGrant: { requestId: REQUEST, mode: "full", phase: "prepared" } });
    const rolledBack = store.createTask(bot.id, "Made before a rollback", false)!;
    expect(levelOf(store, bot.id, rolledBack.threadId)).toBe("ask");
    // clearGrant's rollback: the bot drops to Ask and the grant goes.
    store.patchBot(bot.id, { approvalMode: "ask", autoApprove: false, approvalGrant: undefined });
    expect(levelOf(store, bot.id, rolledBack.threadId)).toBe("ask");
  });

  it("drops a thread made under an unconfirmed bot-wide grant to Ask after a restart, with the bot", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { approvalMode: "full", approvalGrant: { requestId: REQUEST, mode: "full", phase: "confirmed" } });
    const spawned = store.createTask(bot.id, "Interrupted", false)!;

    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.approvalMode).toBe("ask");
    expect(levelOf(reloaded, bot.id, spawned.threadId)).toBe("ask");
  });

  it("keeps an explicit level and the bot's own Ask", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { approvalMode: "full", autoApprove: false, alwaysAllow: ["Bash(ls)"] });
    const asked = store.createTask(bot.id, "API thread", false, undefined, undefined, "ask")!;
    expect(levelOf(store, bot.id, asked.threadId)).toBe("ask");
    const plain = store.createTask(bot.id, "Plain", false)!;
    expect(store.taskByThread(bot.id, plain.threadId)).toMatchObject({ approvalMode: "full", autoApprove: false, alwaysAllow: ["Bash(ls)"] });

    store.patchBot(bot.id, { approvalMode: "ask" });
    store.patchBot(bot.id, { approvalGrant: { requestId: REQUEST, mode: "full", phase: "prepared", threadId: bot.threadId, threadOnly: true } });
    expect(levelOf(store, bot.id, store.createTask(bot.id, "Still Ask", false)!.threadId)).toBe("ask");
  });
});
