import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BurstCardData } from "../../shared/burst.ts";
import { burstLimits, BURST_PLAN_LIMITS, type BurstLimits } from "./limits.ts";
import { childOpening, createBurstManager, mergePrompt, type BurstManagerDeps, type BurstTurnOutcome } from "./manager.ts";
import { openBurstStore, type BurstChild, type BurstRecord, type BurstStore } from "./store.ts";

type Started = { burst: BurstRecord; child: BurstChild & { threadId: string }; text: string; done: (outcome: BurstTurnOutcome) => void };

function harness(input: { limits?: BurstLimits; hasRoom?: () => boolean; store?: BurstStore } = {}) {
  const store = input.store ?? openBurstStore(":memory:");
  const started: Started[] = [];
  const stopped: string[] = [];
  const merges: Array<{ burst: BurstRecord; text: string; done: (outcome: BurstTurnOutcome) => void }> = [];
  const delivered: string[] = [];
  const posted: BurstChild[][] = [];
  const drawn: BurstCardData[] = [];
  let thread = 0, limits = input.limits ?? { parallel: 3, maxTasks: 50, smallPlan: false }, mergeBusy = false, room = input.hasRoom ?? (() => true);
  let postParts = (parts: BurstChild[]) => { posted.push(parts); return "parts as they came"; };
  const deps: BurstManagerDeps = {
    store,
    limits: () => limits,
    hasRoom: () => room(),
    openThread: () => `thread-${++thread}`,
    startChild: async (burst, child, text, done) => { started.push({ burst, child, text, done }); },
    stopChild: (_burst, child) => { stopped.push(child.threadId!); },
    startMerge: async (burst, text, done) => { if (mergeBusy) return false; merges.push({ burst, text: text(), done }); return true; },
    draw: (burst, card) => { drawn.push(card); return burst.cardMessageId ?? "card-1"; },
    postParts: (_burst, parts) => postParts(parts),
    deliver: (_burst, text) => { delivered.push(text); },
    now: () => 1_700_000_000_000,
    log: () => {},
  };
  const manager = createBurstManager(deps);
  return {
    store, manager, started, stopped, merges, delivered, posted, drawn,
    setLimits(next: BurstLimits) { limits = next; }, setRoom(next: () => boolean) { room = next; }, setMergeBusy(next: boolean) { mergeBusy = next; }, setPostParts(next: typeof postParts) { postParts = next; },
    propose(items: readonly string[]) {
      const proposal = manager.propose({ botId: "bot", threadId: "parent", task: "Research companies", instructions: "Find founders and funding.", items, model: { instanceId: "i", model: "fast-1" }, modelName: "fast-1" });
      if ("refused" in proposal) throw new Error(proposal.refused);
      return proposal;
    },
  };
}

const ok = (text: string): BurstTurnOutcome => ({ ok: true, text });
const items = (count: number) => Array.from({ length: count }, (_, index) => `Company ${index + 1}`);

let harnessed: ReturnType<typeof harness>[] = [];
const fresh = (input?: Parameters<typeof harness>[0]) => { const one = harness(input); harnessed.push(one); return one; };

beforeEach(() => { harnessed = []; });
afterEach(() => { for (const one of harnessed) { one.manager.close(); one.store.close(); } });

describe("burst plan limits", () => {
  it("are one row per plan", () => {
    expect(BURST_PLAN_LIMITS.starter).toMatchObject({ parallel: 2, maxTasks: 10 });
    expect(BURST_PLAN_LIMITS.personal).toEqual(BURST_PLAN_LIMITS.starter);
    expect(BURST_PLAN_LIMITS.pro).toMatchObject({ parallel: 10 });
    for (const plan of ["max", "team", "business", "enterprise"]) expect(BURST_PLAN_LIMITS[plan]).toMatchObject({ parallel: 25 });
  });

  it("run on the machine's own compute with no plan on an open-source install, 10 at once unless config says otherwise", () => {
    expect(burstLimits({ cloudHome: false, tier: undefined, maxParallel: undefined })).toMatchObject({ parallel: 10, smallPlan: false });
    expect(burstLimits({ cloudHome: false, tier: "starter", maxParallel: 4 })).toMatchObject({ parallel: 4, smallPlan: false });
  });

  it("hold a Cloud to the smallest row when its plan is unknown", () => {
    expect(burstLimits({ cloudHome: true, tier: undefined, maxParallel: undefined })).toEqual(BURST_PLAN_LIMITS.starter);
    expect(burstLimits({ cloudHome: true, tier: "a-tier-from-a-newer-admin", maxParallel: 99 })).toEqual(BURST_PLAN_LIMITS.starter);
    expect(burstLimits({ cloudHome: true, tier: "max", maxParallel: 1 })).toEqual(BURST_PLAN_LIMITS.max);
  });
});

describe("a burst", () => {
  it("never starts until Run is pressed", () => {
    const { manager, started, drawn, propose } = fresh();
    const card = propose(items(4));
    manager.pump();
    expect(card.phase).toBe("preview");
    expect(drawn.at(-1)).toMatchObject({ phase: "preview", total: 4, sample: ["Company 1", "Company 2", "Company 3", "Company 4"] });
    expect(started).toHaveLength(0);
  });

  it("fans out each item as its own thread with one shared id and the same instructions", () => {
    const { manager, started, store, propose } = fresh({ limits: { parallel: 25, maxTasks: 50, smallPlan: false } });
    const { burstId } = propose(items(3));
    manager.run(burstId);
    expect(started.map((run) => run.child.item)).toEqual(items(3));
    expect(new Set(started.map((run) => run.burst.id))).toEqual(new Set([burstId]));
    expect(new Set(started.map((run) => run.child.threadId)).size).toBe(3);
    for (const run of started) {
      expect(run.text).toContain("Find founders and funding.");
      expect(run.text).toContain(`This part: ${run.child.item}`);
      expect(run.text).toContain("your own words, not the person's");
    }
    expect(store.get(burstId)).toMatchObject({ phase: "running", counts: { running: 3, queued: 0 } });
  });

  it("refuses a second Run and an empty list", () => {
    const { manager, propose } = fresh();
    expect(manager.propose({ botId: "bot", threadId: "parent", task: "x", instructions: "", items: ["only one"], model: { instanceId: "i", model: "m" }, modelName: "m" })).toHaveProperty("refused");
    const { burstId } = propose(items(2));
    manager.run(burstId);
    expect(manager.run(burstId)).toEqual({ refused: "This burst has already started." });
  });
});

describe("the lane", () => {
  it.each([["starter", 2], ["pro", 10], ["max", 25]])("runs at most the plan's limit at once on %s", (plan, parallel) => {
    const limits = BURST_PLAN_LIMITS[plan]!;
    const one = fresh({ limits });
    const { manager, started, store } = one;
    const { burstId } = one.propose(items(Math.min(30, limits.maxTasks)));
    manager.run(burstId);
    expect(started).toHaveLength(Math.min(parallel, Math.min(30, limits.maxTasks)));
    expect(manager.runningCount()).toBe(Math.min(parallel, Math.min(30, limits.maxTasks)));
    let peak = manager.runningCount();
    while (store.get(burstId)!.counts.queued + store.get(burstId)!.counts.running > 0) {
      const next = started.shift()!;
      next.done(ok(`result for ${next.child.item}`));
      peak = Math.max(peak, manager.runningCount());
    }
    expect(peak).toBe(Math.min(parallel, Math.min(30, limits.maxTasks)));
  });

  it("lets the person's own chat go first: nothing new starts while their work waits", () => {
    let personWaits = true;
    const one = fresh({ limits: { parallel: 5, maxTasks: 50, smallPlan: false }, hasRoom: () => !personWaits });
    const { manager, started } = one;
    const { burstId } = one.propose(items(6));
    manager.run(burstId);
    expect(started).toHaveLength(0);
    personWaits = false;
    manager.pump();
    expect(started).toHaveLength(5);
    personWaits = true;
    started.shift()!.done(ok("done"));
    expect(started).toHaveLength(4);
    personWaits = false;
    manager.pump();
    expect(started).toHaveLength(5);
  });

  it("holds a burst to one place when the plan's limit drops", () => {
    const one = fresh({ limits: { parallel: 5, maxTasks: 50, smallPlan: false } });
    const { manager, started, setLimits } = one;
    const { burstId } = one.propose(items(8));
    setLimits({ parallel: 1, maxTasks: 50, smallPlan: false });
    manager.run(burstId);
    expect(started).toHaveLength(1);
  });

  it("stays linear on a very large burst: one indexed take per child, no scan per step", () => {
    const store = openBurstStore(":memory:");
    const calls: Record<string, number> = {};
    const counting = new Proxy(store, {
      get(target, name: keyof BurstStore) {
        const value = target[name];
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          calls[name] = (calls[name] ?? 0) + 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as BurstStore;
    let roomChecks = 0;
    const count = 3_000;
    const one = fresh({ store: counting, limits: { parallel: 25, maxTasks: count, smallPlan: false }, hasRoom: () => { roomChecks += 1; return true; } });
    const { manager, started } = one;
    const { burstId } = one.propose(items(count));
    for (const name of Object.keys(calls)) delete calls[name];
    roomChecks = 0;
    manager.run(burstId);
    const totalStarted = () => (calls.takeQueued ?? 0);
    while (started.length > 0) started.shift()!.done(ok("done"));
    expect(totalStarted()).toBe(count + 1);
    expect(roomChecks).toBeLessThanOrEqual(3 * count + 50);
    expect(calls.children ?? 0).toBe(0);
    expect(calls.childrenIn ?? 0).toBeLessThanOrEqual(4);
    expect(calls.active ?? 0).toBeLessThanOrEqual(2);
    expect(store.get(burstId)!.counts).toMatchObject({ done: count, queued: 0, running: 0 });
  });
});

describe("cancel all and retry failed", () => {
  it("cancels what is queued, stops what runs, and merges nothing", () => {
    const one = fresh({ limits: { parallel: 2, maxTasks: 50, smallPlan: false } });
    const { manager, started, stopped, merges, store } = one;
    const { burstId } = one.propose(items(5));
    manager.run(burstId);
    expect(manager.cancel(burstId)).toMatchObject({ phase: "cancelled" });
    expect(stopped.toSorted()).toEqual(["thread-1", "thread-2"]);
    expect(store.get(burstId)!.counts).toMatchObject({ queued: 0, cancelled: 3, running: 2 });
    for (const run of started) run.done({ ok: false, text: "stopped" });
    expect(store.get(burstId)).toMatchObject({ phase: "cancelled", counts: { cancelled: 5, running: 0 } });
    expect(merges).toHaveLength(0);
  });

  it("cancels a preview without starting anything", () => {
    const one = fresh();
    const { manager, started } = one;
    const { burstId } = one.propose(items(3));
    expect(manager.cancel(burstId)).toMatchObject({ phase: "cancelled" });
    expect(started).toHaveLength(0);
  });

  it("runs only the failed parts again and merges once more", () => {
    const one = fresh({ limits: { parallel: 3, maxTasks: 50, smallPlan: false } });
    const { manager, started, merges, store, delivered } = one;
    const { burstId } = one.propose(items(3));
    manager.run(burstId);
    started[0]!.done(ok("a"));
    started[1]!.done({ ok: false, text: "ran out of memory" });
    started[2]!.done(ok("c"));
    expect(merges).toHaveLength(1);
    merges[0]!.done(ok("merged once"));
    expect(delivered).toEqual(["merged once"]);
    started.length = 0;
    expect(manager.retryFailed(burstId)).toMatchObject({ phase: "running" });
    expect(started.map((run) => run.child.item)).toEqual(["Company 2"]);
    expect(store.get(burstId)!.counts).toMatchObject({ done: 2, running: 1, failed: 0 });
    started[0]!.done(ok("b"));
    expect(merges).toHaveLength(2);
    merges[1]!.done(ok("merged twice"));
    expect(delivered).toEqual(["merged once", "merged twice"]);
    expect(store.get(burstId)).toMatchObject({ phase: "done", counts: { done: 3 } });
  });

  it("has nothing to retry when nothing failed", () => {
    const one = fresh();
    const { manager, started, merges } = one;
    const { burstId } = one.propose(items(2));
    manager.run(burstId);
    started.forEach((run) => { run.done(ok("x")); });
    merges[0]!.done(ok("merged"));
    expect(manager.retryFailed(burstId)).toEqual({ refused: "Nothing failed." });
  });
});

describe("the merged result", () => {
  it("names the parts that failed and is written once on the parent thread", () => {
    const one = fresh({ limits: { parallel: 3, maxTasks: 50, smallPlan: false } });
    const { manager, started, merges, delivered, drawn } = one;
    const { burstId } = one.propose(["Acme", "Globex", "Initech"]);
    manager.run(burstId);
    started[0]!.done(ok("Acme was founded in 1990."));
    started[1]!.done({ ok: false, text: "The provider refused." });
    started[2]!.done(ok("Initech makes software."));
    expect(merges).toHaveLength(1);
    expect(merges[0]!.text).toContain("Acme was founded in 1990.");
    expect(merges[0]!.text).toContain("Globex: The provider refused.");
    expect(merges[0]!.text).toContain("2 parts are done and 1 failed");
    expect(drawn.at(-1)).toMatchObject({ phase: "merging", failed: [{ title: "Globex", reason: "The provider refused." }] });
    merges[0]!.done(ok("Merged: Acme and Initech. Globex failed."));
    expect(delivered).toEqual(["Merged: Acme and Initech. Globex failed."]);
    expect(drawn.at(-1)).toMatchObject({ phase: "done", counts: { done: 2, failed: 1 }, failed: [{ title: "Globex" }] });
  });

  it("waits for a busy parent chat, then merges", async () => {
    const one = fresh({ limits: { parallel: 2, maxTasks: 50, smallPlan: false } });
    const { manager, started, merges, setMergeBusy, store } = one;
    const { burstId } = one.propose(items(2));
    setMergeBusy(true);
    manager.run(burstId);
    started.forEach((run) => { run.done(ok("x")); });
    expect(store.get(burstId)!.phase).toBe("merging");
    expect(merges).toHaveLength(0);
    await Promise.resolve();
    setMergeBusy(false);
    manager.recover();
    expect(merges).toHaveLength(1);
  });

  it("posts the parts as they came when the merge turn fails", () => {
    const one = fresh({ limits: { parallel: 2, maxTasks: 50, smallPlan: false } });
    const { manager, started, merges, delivered, posted } = one;
    const { burstId } = one.propose(items(2));
    manager.run(burstId);
    started.forEach((run) => { run.done(ok("result")); });
    merges[0]!.done({ ok: false, text: "" });
    expect(posted[0]!.map((child) => child.item)).toEqual(items(2));
    expect(delivered).toEqual(["parts as they came"]);
  });

  it("ends even when the chat it was written for is gone", () => {
    const one = fresh({ limits: { parallel: 2, maxTasks: 50, smallPlan: false } });
    const { manager, started, merges, store } = one;
    const { burstId } = one.propose(items(2));
    manager.run(burstId);
    started.forEach((run) => { run.done(ok("result")); });
    one.setPostParts(() => { throw new Error("thread is gone"); });
    merges[0]!.done({ ok: false, text: "" });
    expect(store.get(burstId)!.phase).toBe("done");
  });

  it("keeps the merge prompt within budget for a large burst", () => {
    const done: BurstChild[] = Array.from({ length: 200 }, (_, seq) => ({ burstId: "b", seq, item: `i${seq}`, title: `i${seq}`, status: "done", attempts: 1, result: "x".repeat(20_000) }));
    expect(mergePrompt({ task: "t" }, done, [], 0).length).toBeLessThan(170_000);
  });

  it("marks a child's words as the bot's own", () => {
    expect(childOpening({ task: "t", instructions: "do it" }, { seq: 0, item: "one" }, 2)).toMatch(/^\[Part 1 of 2 .*your own words, not the person's/);
  });
});

describe("a plan's limit on the list", () => {
  it("cuts a preview to the plan's limit and says how many were asked for", () => {
    const one = fresh({ limits: BURST_PLAN_LIMITS.starter! });
    const card = one.propose(items(20));
    expect(card).toMatchObject({ total: 10, requested: 20, taskLimit: 10, smallPlan: true, parallel: 2 });
    expect(one.store.get(card.burstId)!.counts.queued).toBe(10);
  });

  it("re-reads the plan when Run is pressed", () => {
    const one = fresh({ limits: BURST_PLAN_LIMITS.pro! });
    const { burstId } = one.propose(items(30));
    one.setLimits(BURST_PLAN_LIMITS.starter!);
    expect(one.manager.run(burstId)).toMatchObject({ total: 10, requested: 30, taskLimit: 10 });
  });

  it("edits a preview and cuts the new list too", () => {
    const one = fresh({ limits: BURST_PLAN_LIMITS.starter! });
    const { manager, store, propose } = one;
    const { burstId } = propose(items(4));
    expect(manager.edit(burstId, { items: items(15), instructions: "New words." })).toMatchObject({ total: 10, requested: 15, taskLimit: 10 });
    expect(store.get(burstId)!.instructions).toBe("New words.");
    expect(manager.view(burstId)!.items).toHaveLength(10);
    manager.run(burstId);
    expect(manager.edit(burstId, { items: items(2) })).toHaveProperty("refused");
  });
});

describe("after a restart", () => {
  it("puts running parts back in line and runs them again on the same thread", () => {
    const one = fresh({ limits: { parallel: 2, maxTasks: 50, smallPlan: false } });
    const { manager, started, store } = one;
    const { burstId } = one.propose(items(3));
    manager.run(burstId);
    expect(started.map((run) => run.child.threadId)).toEqual(["thread-1", "thread-2"]);
    const restarted = createBurstManager({ store, limits: () => ({ parallel: 2, maxTasks: 50, smallPlan: false }), hasRoom: () => true,
      openThread: () => "thread-new", startChild: async (burst, child, text, done) => { started.push({ burst, child, text, done }); }, stopChild: () => {},
      startMerge: async () => true, draw: () => undefined, postParts: () => "", deliver: () => {}, log: () => {} });
    started.length = 0;
    restarted.recover();
    expect(started.map((run) => run.child.threadId)).toEqual(["thread-1", "thread-2"]);
    restarted.close();
  });
});

describe("a child's start", () => {
  it("is retried when the thread is busy for now, and fails with the reason otherwise", async () => {
    vi.useFakeTimers();
    try {
      const store = openBurstStore(":memory:");
      let tries = 0;
      const finished: Array<() => void> = [];
      const manager = createBurstManager({ store, limits: () => ({ parallel: 1, maxTasks: 50, smallPlan: false }), hasRoom: () => true, openThread: () => "t",
        startChild: (_burst, child, _text, done) => {
          if (child.item === "busy" && ++tries < 3) return Promise.reject(Object.assign(new Error("busy"), { status: 409, code: "thread_busy" }));
          if (child.item === "bad") return Promise.reject(new Error("no such engine"));
          finished.push(() => done(ok("ok")));
          return Promise.resolve();
        }, stopChild: () => {}, startMerge: async () => false, draw: () => undefined, postParts: () => "", deliver: () => {}, log: () => {} });
      const card = manager.propose({ botId: "b", threadId: "p", task: "t", instructions: "", items: ["busy", "bad"], model: { instanceId: "i", model: "m" }, modelName: "m" });
      manager.run((card as BurstCardData).burstId);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(tries).toBe(3);
      expect(finished).toHaveLength(1);
      finished[0]!();
      await vi.advanceTimersByTimeAsync(20_000);
      const rows = manager.view((card as BurstCardData).burstId)!.children;
      expect(rows[0]).toMatchObject({ status: "done" });
      expect(rows[1]).toMatchObject({ status: "failed", error: "no such engine" });
      manager.close();
      store.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
