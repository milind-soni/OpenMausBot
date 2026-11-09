import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { Store } from "../store.ts";
import { createIdleThreads } from "./idle-threads.ts";
import { createPersonStop } from "./person-stop.ts";

type Hold = "setup" | "dispatching" | "engine";

function fixture() {
  const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
  const bot = store.createBot({ name: "Postie" });
  const thread = bot.threadId;
  const task = () => store.taskByThread(bot.id, thread)!;
  const claims = new Map<string, { phase: "setup" | "dispatching" }>();
  const engines = new Set<string>();
  const generations = new Map([[thread, "gen-1"]]);
  const holds = { set: (threadId: string, hold: Hold) => { if (hold === "engine") engines.add(threadId); else claims.set(threadId, { phase: hold }); } };
  const state = { newerTurnDuringInterrupt: false };
  const settled: string[] = [];
  let drains = 0;
  const idle = createIdleThreads({
    store, claims, generations,
    engineTurn: (threadId) => engines.has(threadId),
    settle: (_botId, threadId) => { settled.push(threadId); },
    drain: () => { drains += 1; },
  });
  const stop = createPersonStop({
    store, routines: () => null, handoffs: () => ({ stoppedByPerson: () => {} }) as never,
    // As index.ts's interruptDirectThread: the dispatch claim goes at once, while an engine's turn is only asked to end.
    interruptDirectThread: async (_botId, threadId) => {
      claims.delete(threadId);
      if (state.newerTurnDuringInterrupt) generations.set(threadId, "gen-2");
    },
    stopping: idle.stopping, clearUnattended: () => {}, markStopped: () => {}, stopGoal: () => {},
    working: () => true, asking: () => false, language: () => undefined,
  });
  return { store, bot, thread, task, holds, state, settled, drains: () => drains, idle, stop };
}

describe("a conversation shown working with nothing running for it (server/host/idle-threads.ts)", () => {
  beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

  it("is freed by the person's Stop, though no turn ever started there", async () => {
    const { store, bot, thread, task, settled, drains, stop } = fixture();
    store.setTaskActivity(bot.id, thread, "working");
    await stop.stopThreadForPerson(bot.id, thread);
    expect(task()).toMatchObject({ activity: "idle", busy: false });
    expect(store.bot(bot.id)).toMatchObject({ activity: "idle", busy: false });
    expect(settled).toEqual([thread]);
    expect(drains()).toBe(1);
  });

  it("is freed at once by a Stop during a setup that never returns", async () => {
    const { store, bot, thread, task, holds, settled, drains, stop } = fixture();
    holds.set(thread, "setup");
    store.setTaskActivity(bot.id, thread, "working");
    await stop.stopThreadForPerson(bot.id, thread);
    expect(task()).toMatchObject({ activity: "idle", busy: false });
    expect(settled).toEqual([thread]);
    expect(drains()).toBe(1);
  });

  it.each(["dispatching", "engine"] as const)("a Stop leaves a turn an engine has (%s) to that turn's own end", async (hold) => {
    const { store, bot, thread, task, holds, settled, drains, stop } = fixture();
    holds.set(thread, hold);
    store.setTaskActivity(bot.id, thread, "working");
    await stop.stopThreadForPerson(bot.id, thread);
    expect(task()).toMatchObject({ activity: "working", busy: true });
    expect(settled).toEqual([]);
    expect(drains()).toBe(0);
  });

  it("a Stop never frees a newer turn that began while it interrupted", async () => {
    const { store, bot, thread, task, holds, state, settled, stop } = fixture();
    holds.set(thread, "setup");
    state.newerTurnDuringInterrupt = true;
    store.setTaskActivity(bot.id, thread, "working");
    await stop.stopThreadForPerson(bot.id, thread);
    expect(task()).toMatchObject({ activity: "working", busy: true });
    expect(settled).toEqual([]);
  });

  it("lists for the watchdog only what nothing holds, and frees only that", () => {
    const { store, bot, thread, task, holds, settled, idle } = fixture();
    const other = store.createTask(bot.id, "Other", false)!.threadId;
    const resting = store.createTask(bot.id, "Resting", false)!.threadId;
    store.setTaskActivity(bot.id, thread, "working");
    store.setTaskActivity(bot.id, other, "working");
    store.setTaskActivity(bot.id, resting, "waiting-on-you", true);
    holds.set(other, "setup");
    expect(idle.unheld()).toEqual([{ threadId: thread, botId: bot.id }]);
    idle.free(bot.id, other);
    idle.free(bot.id, resting);
    expect(store.taskByThread(bot.id, other)).toMatchObject({ activity: "working", busy: true });
    expect(store.taskByThread(bot.id, resting)).toMatchObject({ activity: "waiting-on-you", busy: false });
    idle.free(bot.id, thread);
    expect(task()).toMatchObject({ activity: "idle", busy: false });
    expect(settled).toEqual([thread]);
  });
});
