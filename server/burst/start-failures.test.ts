import { afterEach, expect, it } from "vitest";

import { createBurstManager, type BurstManagerDeps, type BurstTurnOutcome } from "./manager.ts";
import { openBurstStore } from "./store.ts";

const close: Array<() => void> = [];
function setup(failure: "open" | "dispatch" | "after completion" | "rejection" | "none") {
  const store = openBurstStore(":memory:");
  const started: Array<{ seq: number; done: (outcome: BurstTurnOutcome) => void }> = [];
  const deps: BurstManagerDeps = {
    store, limits: () => ({ parallel: 1, maxTasks: 10, smallPlan: false }), hasRoom: () => true,
    openThread: (_burst, child) => {
      if (child.seq === 0 && failure === "open") throw new Error("thread creation failed");
      return `thread-${child.seq}`;
    },
    startChild: (_burst, child, _text, done) => {
      if (child.seq === 0) {
        if (failure === "dispatch") throw new Error("dispatch failed");
        if (failure === "rejection") return Promise.reject(new Error("dispatch rejected"));
        if (failure === "after completion") { done({ ok: true, text: "first result" }); throw new Error("late dispatch failure"); }
      }
      started.push({ seq: child.seq, done });
      return Promise.resolve();
    },
    stopChild: () => {}, startMerge: async () => false, draw: () => undefined,
    postParts: () => "", deliver: () => {}, log: () => {},
  };
  const manager = createBurstManager(deps);
  close.push(() => { manager.close(); store.close(); });
  const card = manager.propose({ botId: "bot", threadId: "parent", task: "Compare two items", instructions: "Return each result.",
    items: ["first", "second"], model: { instanceId: "engine", model: "model" }, modelName: "model" });
  if ("refused" in card) throw new Error(card.refused);
  return { manager, store, started, id: card.burstId };
}
afterEach(() => { for (const stop of close.splice(0)) stop(); });

it.each(["open", "dispatch"] as const)("settles a synchronous %s failure and starts the next queued child", (failure) => {
  const { manager, store, started, id } = setup(failure);
  expect(() => manager.run(id)).not.toThrow();
  expect(store.childrenIn(id, "failed")).toHaveLength(1);
  expect(started.map(child => child.seq)).toEqual([1]);
  expect(manager.runningCount()).toBe(1);
  started[0]!.done({ ok: true, text: "second result" });
  expect(manager.runningCount()).toBe(0);
  expect(store.get(id)).toMatchObject({ phase: "merging", counts: { queued: 0, running: 0, failed: 1, done: 1 } });
});

it("does not settle twice when a start completes synchronously before throwing", () => {
  const { manager, store, started, id } = setup("after completion");
  expect(() => manager.run(id)).not.toThrow();
  expect(store.get(id)).toMatchObject({ counts: { running: 1, done: 1, failed: 0 } });
  expect(manager.runningCount()).toBe(1);
  expect(started.map(child => child.seq)).toEqual([1]);
  started[0]!.done({ ok: true, text: "second result" });
  expect(store.get(id)).toMatchObject({ counts: { running: 0, done: 2, failed: 0 } });
});

it("still releases the slot when a start promise rejects", async () => {
  const { manager, store, started, id } = setup("rejection");
  manager.run(id);
  await Promise.resolve();
  expect(started.map(child => child.seq)).toEqual([1]);
  expect(store.get(id)).toMatchObject({ counts: { running: 1, failed: 1 } });
});

it("keeps an ordinary child running until its completion callback", () => {
  const { manager, started, id } = setup("none");
  manager.run(id);
  expect(started.map(child => child.seq)).toEqual([0]);
  expect(manager.runningCount()).toBe(1);
  started[0]!.done({ ok: true, text: "first result" });
  expect(started.map(child => child.seq)).toEqual([0, 1]);
});
