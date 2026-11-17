// The one idle policy (drivers/session-idle.ts) and the per-bot memory cap (bot-memory-cap.ts).
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";

import {
  BOT_CAP_FLOOR_BYTES, BotMemoryWatchdog, botMemoryCapBytes, capLadder, pssBytes, useBotMemoryWatchdog, withBotMemoryCap,
} from "./bot-memory-cap.ts";
import type { ProviderInstance, RuntimeEvent, RuntimeEventListener, SendTurnInput } from "./contracts.ts";
import { armIdleClose, engineIdleMs, idleAfter, stopIdleClose, stoppedForRoom, sweepIdleEngines, type WarmEngine } from "./drivers/session-idle.ts";
import { EngineMemory, memoryStopped, type HostMemory } from "./engine-memory.ts";
import { hostFaultOf, retryCannotFix } from "./host-fault.ts";
import { namesOwnCause } from "./process-shortage.ts";
import { retriesTeammateThread } from "./routine-recovery.ts";
import type { FootprintOwner } from "./perf/bot-footprint.ts";
import type { ProcessRow } from "./perf/process-buckets.ts";
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

describe("a memory cap per bot", () => {
  const inputs = (memoryBytes: number, turns?: number) => ({ gate: "server" as const, memoryBytes, ...(turns === undefined ? {} : { turns }) });

  it("is off on the desktop and where set off, a set number of MB where given, else twice a bot's fair share within bounds", () => {
    const warned: string[] = [];
    expect(botMemoryCapBytes({}, { gate: null, memoryBytes: 16 * GB })).toBeNull();
    expect(botMemoryCapBytes({ OMB_BOT_MEMORY_MAX_MB: "3000" }, { gate: null, memoryBytes: 16 * GB })).toBe(3000 * MB);
    expect(botMemoryCapBytes({ OMB_BOT_MEMORY_MAX_MB: "off" }, inputs(8 * GB, 10))).toBeNull();
    expect(botMemoryCapBytes({ OMB_BOT_MEMORY_MAX_MB: "0" }, inputs(8 * GB, 10))).toBeNull();
    expect(botMemoryCapBytes({ OMB_BOT_MEMORY_MAX_MB: "10" }, inputs(8 * GB, 10))).toBe(256 * MB);
    // 8 GB and 10 turns: a fair share is 819 MB, twice that 1,638 MB, below an engine at its largest with its browser.
    expect(botMemoryCapBytes({}, inputs(8 * GB, 10))).toBe(BOT_CAP_FLOOR_BYTES);
    expect(BOT_CAP_FLOOR_BYTES).toBe(1900 * MB);
    // 32 GB and 8 turns: 8 GB.
    expect(botMemoryCapBytes({ OMB_BOT_MEMORY_MAX_MB: "auto" }, inputs(32 * GB, 8))).toBe(8 * GB);
    // 2 GB: never more than 80% of the memory.
    expect(botMemoryCapBytes({}, inputs(2 * GB, 2))).toBe(Math.round(1.6 * GB));
    // Without a number of turns: as many as fit at an engine's usual 700 MB.
    expect(botMemoryCapBytes({}, inputs(64 * GB))).toBe(BOT_CAP_FLOOR_BYTES);
    expect(botMemoryCapBytes({}, inputs(64 * GB, 16))).toBe(8 * GB);
    expect(botMemoryCapBytes({ OMB_BOT_MEMORY_MAX_MB: "lots" }, inputs(8 * GB, 10), (line) => warned.push(line))).toBe(BOT_CAP_FLOOR_BYTES);
    expect(warned).toEqual(['OMB_BOT_MEMORY_MAX_MB="lots" is not a number of MB, "auto" or "off", so the default is used']);
  });

  it("reports the ladder's rungs this host offers, and enforces with the watchdog", () => {
    expect(capLadder(GB, { platform: "darwin" })).toEqual({ rung: "none", offered: [] });
    const files: Record<string, string> = { "/proc/self/cgroup": "0::/system.slice/openmausbot.service\n", "/sys/fs/cgroup/system.slice/openmausbot.service/cgroup.controllers": "cpu io memory pids\n" };
    const read = (path: string) => files[path] ?? null;
    expect(capLadder(GB, { platform: "linux", read, writable: () => true, exists: () => true })).toEqual({ rung: "watchdog", offered: ["systemd-scope", "cgroup", "watchdog"] });
    // A container's read-only cgroup: only the watchdog.
    expect(capLadder(GB, { platform: "linux", read: (path) => (path === "/proc/self/cgroup" ? "0::/\n" : path === "/sys/fs/cgroup/cgroup.controllers" ? "memory pids\n" : null), writable: () => false, exists: () => false }))
      .toEqual({ rung: "watchdog", offered: ["watchdog"] });
    expect(capLadder(null, { platform: "linux", read, writable: () => false, exists: () => false })).toEqual({ rung: "none", offered: ["watchdog"] });
    expect(pssBytes(7, (path) => (path === "/proc/7/smaps_rollup" ? "Rss:  2048 kB\nPss:   1024 kB\n" : null))).toBe(MB);
    expect(pssBytes(7, () => null)).toBeNull();
  });

  /** Bot A: engine 200 and its tool server 201. Bot B: engine 300, tool server 301, and its browser 500 with Chrome 501
   * (100 MB). Shared: an engine 400 both bots use. The sizes are each bot's engine and tool server together. */
  function processes(sizes: { a?: number; b?: number; shared?: number } = {}) {
    const row = (pid: number, ppid: number, mb: number, pgid = pid): ProcessRow => ({ pid, ppid, name: "x", cpuMs: 0, rssBytes: mb * MB, start: `s${pid}`, pgid, sid: pgid });
    return [
      row(100, 1, 200),
      row(200, 100, (sizes.a ?? 1200) - 200), row(201, 200, 200, 200),
      row(300, 100, (sizes.b ?? 600) - 100), row(301, 300, 100, 300),
      row(500, 1, 40), row(501, 500, 60, 500),
      row(400, 100, sizes.shared ?? 5000),
    ];
  }
  const owners: FootprintOwner[] = [
    { pid: 200, botIds: ["bot_a"], kind: "engine" }, { pid: 300, botIds: ["bot_b"], kind: "engine" },
    { pid: 500, botIds: ["bot_b"], kind: "browser" }, { pid: 400, botIds: ["bot_a", "bot_b"], kind: "engine" },
  ];
  /** By default every process's proportional size reads as its resident size. */
  function dog(rows: () => ProcessRow[], pss: (pid: number) => number | null = (pid) => rows().find((row) => row.pid === pid)?.rssBytes ?? null,
    startOf: (pid: number) => string | null = (pid) => `s${pid}`) {
    const signals: string[] = [], closed: string[] = [], logs: string[] = [];
    let clock = 1_800_000_000_000;
    const watchdog = new BotMemoryWatchdog({ cap: () => 1000 * MB, list: rows, owners: () => owners, pss, startOf, graceMs: 0, now: () => clock,
      signal: (pid, value) => signals.push(`${value} ${pid}`), closeBrowsers: async (botId) => { closed.push(botId); }, log: (line) => logs.push(line) });
    return { watchdog, signals, closed, logs, advance: (ms: number) => { clock += ms; }, now: () => clock };
  }

  it("stops a bot that stays over its cap: its engine's processes and its own browser, never another bot's or a shared process", async () => {
    let sizes = { a: 900, b: 1200 };
    const h = dog(() => processes(sizes));
    expect(await h.watchdog.check()).toEqual([]);
    expect(h.signals).toEqual([]);
    const [stop] = await h.watchdog.check();
    expect(stop).toMatchObject({ botId: "bot_b", usedBytes: 1300 * MB, capBytes: 1000 * MB });
    expect(h.signals).toEqual(["SIGTERM 300", "SIGTERM 301", "SIGKILL 300", "SIGKILL 301"]);
    expect(h.closed).toEqual(["bot_b"]);
    expect(h.logs).toEqual(["memory: bot bot_b used 1300 MB, more than the 1000 MB this server allows one bot; stopping its engine (2 processes) and closing its browser"]);
    expect(h.watchdog.stopOf("bot_b")).toMatchObject({ botId: "bot_b" });
    expect(h.watchdog.stoppedPid(300)).toBe(true);
    expect(h.watchdog.stoppedPid(200)).toBe(false);
    expect(h.watchdog.stops()).toBe(1);
    // A bot that dips back under its cap starts counting again.
    sizes = { a: 1100, b: 500 };
    expect(await h.watchdog.check()).toEqual([]);
    sizes = { a: 900, b: 500 };
    expect(await h.watchdog.check()).toEqual([]);
    sizes = { a: 1100, b: 500 };
    expect(await h.watchdog.check()).toEqual([]);
    expect(h.signals).toHaveLength(4);
  });

  it("stops a bot far over its cap at once, and counts shared pages once (by proportional size) before stopping anything", async () => {
    const far = dog(() => processes({ a: 1600 }));
    expect((await far.watchdog.check()).map((stop) => stop.botId)).toEqual(["bot_a"]);
    expect(far.signals).toEqual(["SIGTERM 200", "SIGTERM 201", "SIGKILL 200", "SIGKILL 201"]);
    expect(far.closed).toEqual([]);
    // Resident 1,600 MB, but 700 MB of it pages shared with other processes: 900 MB its own share, under the cap.
    const shared = dog(() => processes({ a: 1600 }), (pid) => (pid === 200 ? 700 * MB : pid === 201 ? 200 * MB : null));
    expect(await shared.watchdog.check()).toEqual([]);
    expect(await shared.watchdog.check()).toEqual([]);
    expect(shared.signals).toEqual([]);
  });

  it("stops a bot whose shares can't be read only when it stays far over, its resident pages erring high", async () => {
    let sizes = { a: 1300 };
    const h = dog(() => processes(sizes), () => null);
    expect(await h.watchdog.check()).toEqual([]);
    expect(await h.watchdog.check()).toEqual([]);
    expect(await h.watchdog.check()).toEqual([]);
    sizes = { a: 1600 };
    expect(await h.watchdog.check()).toEqual([]);
    expect((await h.watchdog.check()).map((stop) => stop.botId)).toEqual(["bot_a"]);
  });

  it("leaves alone a pid the system gave to another process since it was read", async () => {
    const h = dog(() => processes({ a: 1600 }), undefined, (pid) => (pid === 201 ? "later" : `s${pid}`));
    await h.watchdog.check();
    expect(h.signals).toEqual(["SIGTERM 200", "SIGKILL 200"]);
  });

  it("ends the stopped bot's turn with a line that says why, and only that bot's turn that ran then", async () => {
    const h = dog(() => processes({ b: 1600 }));
    const listeners = new Set<RuntimeEventListener>();
    const instance = withBotMemoryCap({
      instanceId: "i", driverKind: "claudeAgent", displayName: "x", enabled: true,
      adapter: { sendTurn: async () => ({ turnId: "t" }), onEvent: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); } },
    } as unknown as ProviderInstance, () => h.watchdog, (botId) => (botId === "bot_b" ? "Researcher" : botId), h.now);
    const seen: RuntimeEvent[] = [];
    instance.adapter.onEvent((event) => seen.push(event));
    const emit = (event: Partial<RuntimeEvent>) => { for (const listener of listeners) listener({ eventId: "e", provider: "claudeAgent", createdAt: "", ...event } as RuntimeEvent); };
    const shown = () => seen.map((event) => (event.type === "runtime.error" ? event.message : event.type));
    await instance.adapter.sendTurn({ threadId: "tb", botId: "bot_b", text: "go" } as SendTurnInput);
    await instance.adapter.sendTurn({ threadId: "tc", botId: "bot_b", text: "go" } as SendTurnInput);
    await instance.adapter.sendTurn({ threadId: "ta", botId: "bot_a", text: "go" } as SendTurnInput);
    h.advance(1_000);
    await h.watchdog.check();
    emit({ threadId: "tb", turnId: "t", type: "runtime.error", message: "the process running this turn's AI ended" });
    emit({ threadId: "tb", turnId: "t", type: "turn.completed", ok: false, stopReason: "exit_before_result" });
    emit({ threadId: "ta", turnId: "t", type: "runtime.error", message: "something else" });
    const line = "Researcher used more memory than this server allows for one bot (1700 MB of 1000 MB), so I stopped this task to keep the other bots running. "
      + "Send the message again to start over; if it keeps happening, give this task less to do at once, or give the server more memory.";
    expect(shown()).toEqual([line, "turn.completed", "something else"]);
    expect(seen[0]).toMatchObject({ text: { key: "chat.notice.botMemoryCap", params: { bot: "Researcher", used: "1700", cap: "1000" } } });
    // A fault a retry cannot fix: no automatic retry or Chief retry starts the bot into the same cap again.
    expect(hostFaultOf(line)).toBe("bot_memory");
    expect(retryCannotFix("bot_memory")).toBe(true);
    expect(retriesTeammateThread(line)).toBe(false);
    expect(namesOwnCause(line)).toBe(true);
    expect(memoryStopped(line)).toBe(false);
    // A turn that ends without an error of its own still says why, first.
    seen.length = 0;
    emit({ threadId: "tc", turnId: "t", type: "turn.completed", ok: false, stopReason: "exit_before_result" });
    expect(shown()).toEqual([line, "turn.completed"]);
    await settle();
    // A turn started after the stop fails for its own reasons.
    seen.length = 0;
    h.advance(1_000);
    await instance.adapter.sendTurn({ threadId: "tb", botId: "bot_b", text: "again" } as SendTurnInput);
    emit({ threadId: "tb", turnId: "t2", type: "runtime.error", message: "its own failure" });
    expect(shown()).toEqual(["its own failure"]);
  });

  it("keeps a driver from starting the stopped engine again at once", async () => {
    const h = dog(() => processes({ b: 1600 }));
    await h.watchdog.check();
    useBotMemoryWatchdog(h.watchdog);
    try {
      expect(stoppedForRoom("tb", 300)).toBe(true);
      expect(stoppedForRoom("ta", 200)).toBe(false);
    } finally { useBotMemoryWatchdog(null); }
  });
});
