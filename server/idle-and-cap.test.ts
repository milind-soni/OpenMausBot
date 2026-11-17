// The one idle policy (drivers/session-idle.ts); the per-bot memory cap's own tests are in bot-memory-cap.test.ts.
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";

import { armedIdleCount, armIdleClose, engineIdleMs, idleAfter, stopIdleClose, sweepIdleEngines, type WarmEngine } from "./drivers/session-idle.ts";
import { EngineMemory, type HostMemory } from "./engine-memory.ts";
import { ProcessBudget } from "./process-room.ts";
import { forgetPresence, sawThread } from "./thread-presence.ts";

const MB = 1024 * 1024, GB = 1024 * MB;
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly pid: number;
  constructor(pid: number) { super(); this.pid = pid; }
  exit(signal: NodeJS.Signals | null = null) {
    if (signal) this.signalCode = signal; else this.exitCode = 0;
    this.emit("exit", this.exitCode, signal);
  }
}

/** A self-hosted server under a pids limit (each engine 44 tasks) with `available` memory, or memory that can't be read. */
function server(options: { pids?: number; available?: number | null; total?: number } = {}) {
  let clock = 1_800_000_000_000, nextPid = 1000;
  const children = new Map<number, FakeChild>();
  const signals: string[] = [];
  const state = { base: 26, available: options.available === undefined ? 60 * GB : options.available, extraTasks: 0 };
  const total = options.total ?? 64 * GB;
  const budget = new ProcessBudget({ read: () => ({ max: options.pids ?? 512, current: state.base + state.extraTasks + children.size * 44 }), now: () => clock, log: () => {} });
  const memory = new EngineMemory({
    enabled: true, host: "server", turns: 100, processes: budget, tickMs: 5,
    tree: () => null,
    read: (): HostMemory | null => (state.available === null ? null : { totalBytes: total, availableBytes: Math.max(0, state.available - children.size * 300 * MB), swapFreeBytes: 0, oomKills: 0, fullStall10: 0 }),
    groups: () => new Map([...children.keys()].map((pid) => [pid, 300 * MB])),
    now: () => clock, log: () => {},
    signal: (pid, signal) => {
      signals.push(`${signal} -${pid}`);
      const child = children.get(pid);
      if (child && child.exitCode === null && child.signalCode === null) queueMicrotask(() => child.exit(signal));
    },
  });
  const spawn = (threadId: string) => memory.within(threadId, () => {
    const child = new FakeChild(nextPid++);
    children.set(child.pid, child);
    child.once("exit", () => children.delete(child.pid));
    memory.track(child as unknown as ChildProcess);
    return child;
  });
  /** A finished turn whose engine stays loaded. */
  const idleEngine = async (threadId: string) => {
    memory.turnStarted(threadId);
    spawn(threadId);
    memory.turnEnded(threadId);
  };
  return { memory, budget, children, signals, state, spawn, idleEngine, advance: (ms: number) => { clock += ms; } };
}

describe("one idle policy, shorter as the server runs short of room", () => {
  afterEach(forgetPresence);

  it("scales a time by the room left, down to a tenth, never below its floor", () => {
    expect(idleAfter(600_000, 10_000, 1)).toBe(600_000);
    expect(idleAfter(600_000, 10_000, 0.5)).toBe(300_000);
    expect(idleAfter(600_000, 10_000, 0)).toBe(60_000);
    expect(idleAfter(600_000, 90_000, 0.1)).toBe(90_000);
    expect(idleAfter(600_000, 10_000, 3)).toBe(600_000);
  });

  it("reads the room for processes the way admission does: free below the margin over half the limit", () => {
    let current = 26;
    let clock = 0;
    const budget = new ProcessBudget({ read: () => ({ max: 1000, current }), now: () => clock, log: () => {} });
    expect(budget.headroom()).toBe(1);
    current = 600; // 1000 - 100 margin - 600 = 300 free, of 500
    expect(budget.headroom()).toBeCloseTo(0.6, 5);
    current = 890;
    expect(budget.headroom()).toBe(0.1);
    current = 26;
    budget.spawnFailed("EAGAIN");
    expect(budget.headroom()).toBe(0.1);
    clock += 31_000;
    expect(budget.headroom()).toBe(1);
    expect(new ProcessBudget({ read: () => ({ max: null, current: null }), log: () => {} }).headroom()).toBe(1);
  });

  it("takes the lower of memory's and processes' room, and calls the server short when admission would hold an engine back", async () => {
    const h = server({ pids: 1000 });
    expect(h.memory.roomFactor()).toBe(1);
    expect(h.memory.shortOfRoom()).toBe(false);
    h.state.extraTasks = 574; // 600 tasks of 1000
    expect(h.memory.roomFactor()).toBeCloseTo(0.6, 5);
    h.state.extraTasks = 830; // 856 tasks: one more engine's 60 would not fit under 900
    expect(h.memory.shortOfRoom()).toBe(true);
    h.state.extraTasks = 0;
    h.state.available = 500 * MB; // below the 6.4 GB floor of a 64 GB machine
    expect(h.memory.shortOfRoom()).toBe(true);
    expect(h.memory.roomFactor()).toBe(0.1);
    expect(new EngineMemory({ enabled: false, read: () => null }).roomFactor()).toBe(1);
    // A Cloud home has no pids limit to read: memory alone.
    expect(new EngineMemory({ enabled: true, host: "cloud", read: () => ({ totalBytes: 4 * GB, availableBytes: 3.4 * GB, swapFreeBytes: 0, oomKills: 0, fullStall10: 0 }) }).roomFactor()).toBe(1);
  });

  it("gives a watched conversation's engine (per-chat) less time as the pids limit fills, as it already did for memory", () => {
    const now = 1_800_000_000_000;
    sawThread("open", now - 60_000);
    const policy = { idleMs: 10 * 60_000, minimumMs: 10_000 };
    expect(engineIdleMs("open", policy, { enabled: true, headroom: () => 1, roomFactor: () => 0.25 }, now)).toBe(150_000);
    expect(engineIdleMs("open", policy, { enabled: true, headroom: () => 0.5 }, now)).toBe(300_000);
    expect(engineIdleMs("open", policy, { enabled: false, headroom: () => 0.1, roomFactor: () => 0.1 }, now)).toBe(600_000);
  });

  it("closes engines already kept too long once room shrinks, keeps a keep-warm hold until the server is short, and never a busy one", () => {
    const start = 1_800_000_000_000;
    sawThread("t1", start); sawThread("t2", start); sawThread("t3", start);
    const policy = { idleMs: 10 * 60_000, minimumMs: 10_000 };
    const closed: string[] = [];
    const busy = { t3: true } as Record<string, boolean>;
    const warm = (threadId: string, held = false): WarmEngine => ({ threadId, policy, idle: () => !busy[threadId], held: () => held, close: () => closed.push(threadId) });
    const timers = [armIdleClose("k1", 600_000, warm("t1"), start), armIdleClose("k2", 600_000, warm("t2", true), start), armIdleClose("k3", 600_000, warm("t3"), start)];
    try {
      const room = { factor: 1, short: false };
      const memory = { enabled: true, headroom: () => room.factor, roomFactor: () => room.factor, shortOfRoom: () => room.short };
      // Three minutes on, with room to spare: nothing closes before its ten minutes.
      expect(sweepIdleEngines(memory, start + 3 * 60_000)).toBe(0);
      // Room shrinks to a fifth: two minutes is the time now, and t1 has been idle three.
      room.factor = 0.2;
      expect(sweepIdleEngines(memory, start + 3 * 60_000)).toBe(1);
      expect(closed).toEqual(["t1"]);
      // Short of room: the keep-warm hold yields too; the busy engine stays.
      room.short = true;
      expect(sweepIdleEngines(memory, start + 3 * 60_000)).toBe(1);
      expect(closed).toEqual(["t1", "t2"]);
      // Off where turns don't wait for room.
      expect(sweepIdleEngines({ ...memory, enabled: false }, start + 60 * 60_000)).toBe(0);
    } finally {
      for (const [index, timer] of timers.entries()) stopIdleClose(`k${index + 1}`, timer);
    }
  });

  it("lets an engine go from the sweep's list once it is busy again or gone, and an old session's end leaves a newer one's entry", () => {
    const start = 1_800_000_000_000;
    const policy = { idleMs: 10 * 60_000, minimumMs: 10_000 };
    const before = armedIdleCount();
    const state = { busy: false };
    const engine: WarmEngine = { threadId: "g1", policy, idle: () => !state.busy, close: () => {} };
    const old = armIdleClose("g", 600_000, engine, start);
    // A new turn took the session (the driver stops the idle close), then it went idle again under a new timer.
    stopIdleClose("g", old);
    expect(armedIdleCount()).toBe(before);
    const fresh = armIdleClose("g", 600_000, engine, start);
    // The earlier session of this conversation ends now, with its old timer: the newer entry stays.
    stopIdleClose("g", old);
    expect(armedIdleCount()).toBe(before + 1);
    // An entry whose engine is busy again (its end came by a plain clearTimeout) is dropped at the next sweep.
    state.busy = true;
    clearTimeout(fresh);
    sweepIdleEngines({ enabled: true, headroom: () => 0.5, roomFactor: () => 0.5, shortOfRoom: () => false }, start + 60_000);
    expect(armedIdleCount()).toBe(before);
  });

  it("runs the sweep on every tick of the gate", () => {
    const h = server();
    let swept = 0;
    h.memory.useIdleSweep(() => { swept += 1; });
    h.memory.tick();
    h.memory.useIdleSweep(() => { throw new Error("boom"); });
    expect(() => h.memory.tick()).not.toThrow();
    expect(swept).toBe(1);
  });
});

describe("an idle engine goes before admission makes new work wait", () => {
  it("when memory is short", async () => {
    const h = server({ total: 4 * GB, available: 2 * GB });
    await h.idleEngine("old");
    h.advance(91_000);
    h.state.available = 0.9 * GB; // 600 MB free with the idle engine: 190 MB above the floor, less than one more engine
    const admitted = h.memory.admit("new", new AbortController().signal, () => {});
    await settle();
    expect(h.signals).toEqual(["SIGTERM -1000"]);
    expect(await admitted).toBe(true);
  });

  it("when the pids limit is full", async () => {
    const h = server({ pids: 512 });
    // Nine idle engines: 422 tasks, and one more engine's 60 would pass the 461 kept below the limit.
    for (const thread of ["a", "b", "c", "d", "e", "f", "g", "h", "i"]) await h.idleEngine(thread);
    h.memory.turnStarted("busy");
    const admitted = h.memory.admit("new", new AbortController().signal, () => {});
    await settle();
    expect(h.signals[0]).toBe("SIGTERM -1000");
    expect(await admitted).toBe(true);
  });

  it("when memory can't be read and the pids limit is full", async () => {
    const h = server({ pids: 512, available: null });
    for (const thread of ["a", "b", "c", "d", "e", "f", "g", "h", "i"]) await h.idleEngine(thread);
    h.memory.turnStarted("busy");
    const admitted = h.memory.admit("new", new AbortController().signal, () => {});
    await settle();
    expect(h.signals[0]).toBe("SIGTERM -1000");
    expect(await admitted).toBe(true);
  });

  it("and a browser that has no room to open asks for the same", async () => {
    const h = server();
    expect(await h.memory.reclaimIdle()).toBe(false);
    await h.idleEngine("a");
    await h.idleEngine("b");
    expect(await h.memory.reclaimIdle()).toBe(true);
    expect(h.signals).toEqual(["SIGTERM -1000"]);
  });
});
