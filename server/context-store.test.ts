// Phase 1 part 1: the compaction budget reads main's per-task context reading
// (usage.context.tokens, the last model call's window fill), and a contextReset
// flag makes the next dispatch start a fresh engine session.
import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { Store } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

describe("Store context fields", () => {
  beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

  it("keeps main's last-turn and context readings, which the compaction budget reads", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.addTaskUsage(bot.id, bot.threadId, { input: 1_000, output: 10, costUsd: null, context: { tokens: 900, window: 200_000 } });
    store.addTaskUsage(bot.id, bot.threadId, { input: 44_000, output: 10, costUsd: null, context: { tokens: 22_000 } });
    expect(store.activeTask(bot.id)!.usage).toMatchObject({ input: 45_000, lastTurn: { input: 44_000 }, context: { tokens: 22_000 }, turns: 2 });
  });

  it("persists contextReset and clears it like rewound", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchTask(bot.id, bot.threadId, { contextReset: true });
    expect(new Store(selection).activeTask(bot.id)!.contextReset).toBe(true);
    store.patchTask(bot.id, bot.threadId, { contextReset: false, resumeCursors: {} });
    expect(new Store(selection).activeTask(bot.id)!.contextReset).toBe(false);
  });
});
