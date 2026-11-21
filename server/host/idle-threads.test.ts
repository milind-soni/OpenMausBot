import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { RoutineRun } from "../routines.ts";
import { Store } from "../store.ts";
import { createIdleThreads } from "./idle-threads.ts";
import { createPersonStop } from "./person-stop.ts";

type Hold = "setup" | "dispatching" | "engine";

function fixture({ routineRun = false } = {}) {
  const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
  const bot = store.createBot({ name: "Postie" });
  const thread = bot.threadId;
  const task = () => store.taskByThread(bot.id, thread)!;
  const claims = new Map<string, { phase: "setup" | "dispatching" }>();
  const engines = new Set<string>();
  const generations = new Map([[thread, "gen-1"]]);
  const holds = { set: (threadId: string, hold: Hold) => { if (hold === "engine") engines.add(threadId); else claims.set(threadId, { phase: hold }); } };
  const state = { newerTurnDuringInterrupt: false };
  const settled: string[] = [], released: string[] = [], cancelledRuns: string[] = [];
  let drains = 0;
  const idle = createIdleThreads({
    store, claims, generations,
    engineTurn: (threadId) => engines.has(threadId),
    settle: (_botId, threadId) => { settled.push(threadId); },
    releaseComputer: (_botId, threadId) => { released.push(threadId); },
    drain: () => { drains += 1; },
  });
  // As index.ts's interrupts, a person's or a routine's: the dispatch claim goes at once, while an engine's turn is only asked to end.
  const interrupt = (threadId: string) => {
    claims.delete(threadId);
    if (state.newerTurnDuringInterrupt) generations.set(threadId, "gen-2");
  };
  const run = { id: "run-1", threadId: thread } as RoutineRun;
  const stop = createPersonStop({
    store, handoffs: () => ({ stoppedByPerson: () => {} }) as never,
    routines: () => (routineRun ? { activeBotRunForBot: () => run, cancelRun: async (id: string) => { cancelledRuns.push(id); interrupt(thread); return null; } } : null),
    interruptDirectThread: async (_botId, threadId) => interrupt(threadId),
    stopping: idle.stopping, clearUnattended: () => {}, markStopped: () => {}, stopGoal: () => {},
    working: () => true, asking: () => false, language: () => undefined,
  });
  return { store, bot, thread, task, holds, state, settled, released, cancelledRuns, drains: () => drains, idle, stop };
}

describe("a conversation shown working with nothing running for it (server/host/idle-threads.ts)", () => {
  beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

  it("is freed by the person's Stop, though no turn ever started there", async () => {
    const { store, bot, thread, task, settled, released, drains, stop } = fixture();
    store.setTaskActivity(bot.id, thread, "working");
    await stop.stopThreadForPerson(bot.id, thread);
    expect(task()).toMatchObject({ activity: "idle", busy: false });
    expect(store.bot(bot.id)).toMatchObject({ activity: "idle", busy: false });
    expect(settled).toEqual([thread]);
    expect(released).toEqual([thread]);
    expect(drains()).toBe(1);
  });

  it("is freed at once by a Stop during a setup that never returns, which lets go of its computer", async () => {
    const { store, bot, thread, task, holds, settled, released, drains, stop } = fixture();
    holds.set(thread, "setup");
    store.setTaskActivity(bot.id, thread, "working");
    await stop.stopThreadForPerson(bot.id, thread);
    expect(task()).toMatchObject({ activity: "idle", busy: false });
    expect(settled).toEqual([thread]);
    expect(released).toEqual([thread]);
    expect(drains()).toBe(1);
  });

  it("is freed by a Stop that cancels a routine run whose setup never returns", async () => {
    const { store, bot, thread, task, holds, released, cancelledRuns, stop } = fixture({ routineRun: true });
    holds.set(thread, "setup");
    store.setTaskActivity(bot.id, thread, "working");
    await stop.stopThreadForPerson(bot.id, thread);
    expect(cancelledRuns).toEqual(["run-1"]);
    expect(task()).toMatchObject({ activity: "idle", busy: false });
    expect(released).toEqual([thread]);
  });

  it.each(["dispatching", "engine"] as const)("a Stop leaves a turn an engine has (%s) to that turn's own end", async (hold) => {
    for (const routineRun of [false, true]) {
      const { store, bot, thread, task, holds, settled, released, drains, stop } = fixture({ routineRun });
      holds.set(thread, hold);
      store.setTaskActivity(bot.id, thread, "working");
      await stop.stopThreadForPerson(bot.id, thread);
      expect(task()).toMatchObject({ activity: "working", busy: true });
      expect(settled).toEqual([]);
      expect(released).toEqual([]);
      expect(drains()).toBe(0);
    }
  });

  it("a Stop never frees a newer turn that began while it interrupted, nor touches that turn's computer", async () => {
    const { store, bot, thread, task, holds, state, settled, released, stop } = fixture();
    holds.set(thread, "setup");
    state.newerTurnDuringInterrupt = true;
    store.setTaskActivity(bot.id, thread, "working");
    await stop.stopThreadForPerson(bot.id, thread);
    expect(task()).toMatchObject({ activity: "working", busy: true });
    expect(settled).toEqual([]);
    expect(released).toEqual([]);
  });

  it("lists for the watchdog only what nothing holds, and frees only that", () => {
    const { store, bot, thread, task, holds, settled, released, idle } = fixture();
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
    expect(released).toEqual([thread]);
  });
});
