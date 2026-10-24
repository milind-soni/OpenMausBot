import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { TurnNotStartedError, type ProviderInstance, type RuntimeEvent, type RuntimeEventListener, type SendTurnInput } from "./contracts.ts";
import {
  BROWSER_BYTES, EngineMemory, memoryStallText, memoryStillWaitingText, memoryStopText, memoryWaitText, processGroupBytes, readHostMemory, withEngineMemory,
  type HostMemory,
} from "./engine-memory.ts";
import { OOM_SCORE, spawnWithOomScore } from "./oom-score.ts";

const MB = 1024 * 1024, GB = 1024 * MB;

describe("reading the host", () => {
  it("reads memory, swap, the OOM kill count and the memory stall from /proc", () => {
    const files: Record<string, string> = {
      "/proc/meminfo": "MemTotal:        4022248 kB\nMemFree:          112000 kB\nMemAvailable:     524288 kB\nSwapTotal:             0 kB\nSwapFree:              0 kB\n",
      "/proc/vmstat": "nr_free_pages 28000\noom_kill 3\n",
      "/proc/pressure/memory": "some avg10=61.20 avg60=40.00 avg300=12.00 total=99\nfull avg10=47.50 avg60=30.00 avg300=9.00 total=88\n",
    };
    expect(readHostMemory((path) => files[path] ?? (() => { throw new Error("ENOENT"); })())).toEqual({
      totalBytes: 4022248 * 1024, availableBytes: 512 * MB, swapFreeBytes: 0, oomKills: 3, fullStall10: 47.5 });
    expect(readHostMemory((path) => { if (path === "/proc/meminfo") return files[path]!; throw new Error("ENOENT"); }))
      .toMatchObject({ oomKills: null, fullStall10: null });
    expect(readHostMemory(() => { throw new Error("ENOENT"); })).toBeNull();
  });

  it("adds up each process group: an engine and the MCP servers it started", () => {
    const stat = (pid: number, comm: string, pgrp: number, rssPages: number) =>
      `${pid} (${comm}) S 1 ${pgrp} ${pgrp} 0 -1 4194560 ${Array(14).fill(0).join(" ")} ${rssPages} 18446744073709551615`;
    const stats: Record<string, string> = {
      "/proc/100/stat": stat(100, "opencode", 100, 100_000),
      "/proc/101/stat": stat(101, "node (mcp) x", 100, 25_000),
      "/proc/200/stat": stat(200, "chrome", 200, 50_000),
    };
    const groups = processGroupBytes(() => ["100", "101", "200", "self", "999"], (path) => stats[path] ?? (() => { throw new Error("gone"); })());
    expect(groups.get(100)).toBe(125_000 * 4096);
    expect(groups.get(200)).toBe(50_000 * 4096);
  });

  it("starts a process with an OOM score of its own and puts this process's back, whatever the spawn does", () => {
    const writes: string[] = [];
    let own = "-800";
    const file = { read: () => `${own}\n`, write: (_path: string, data: string) => { writes.push(data); own = data; } };
    const spawned = spawnWithOomScore(OOM_SCORE.engine, () => own, file);
    expect(process.platform === "linux" ? [spawned, writes, own] : [spawned, writes]).toEqual(process.platform === "linux" ? ["1000", ["1000", "-800"], "-800"] : ["-800", []]);
    writes.length = 0;
    expect(() => spawnWithOomScore(OOM_SCORE.engine, () => { throw new Error("ENOENT"); }, file)).toThrow("ENOENT");
    if (process.platform === "linux") expect([writes, own]).toEqual([["1000", "-800"], "-800"]);
    // A score that can't be read or set: the process starts as before.
    expect(spawnWithOomScore(OOM_SCORE.engine, () => "started", { read: () => { throw new Error("EACCES"); }, write: () => { throw new Error("no"); } })).toBe("started");
  });
});

it("scales an idle engine's keep-alive by the memory left above the floor", () => {
  const at = (available: number) => new EngineMemory({ enabled: true,
    read: () => ({ totalBytes: 4 * GB, availableBytes: available, swapFreeBytes: 0, oomKills: 0, fullStall10: 0 }) }).headroom();
  // The floor is 410 MB on 4 GB; half the machine above it is full headroom.
  expect(at(3.4 * GB)).toBe(1);
  expect(at(2 * GB + 410 * MB)).toBeCloseTo(1, 2);
  expect(at(1 * GB + 410 * MB)).toBeCloseTo(0.5, 2);
  expect(at(300 * MB)).toBe(0.1);
  expect(new EngineMemory({ enabled: false, read: () => ({ totalBytes: 4 * GB, availableBytes: 0, swapFreeBytes: 0, oomKills: 0, fullStall10: 0 }) }).headroom()).toBe(1);
  expect(new EngineMemory({ enabled: true, read: () => null }).headroom()).toBe(1);
});

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

/** A 4 GB home without swap: `available` before any engine (the test may change it), less `perEngine` per running engine. */
function host(options: { available?: number; perEngine?: number; tickMs?: number } = {}) {
  let clock = 1_800_000_000_000, oomKills = 0;
  const perEngine = options.perEngine ?? 700 * MB;
  const state = { available: options.available ?? 3.4 * GB, fullStall10: 0 };
  const children = new Map<number, FakeChild>();
  const signals: string[] = [];
  const logs: string[] = [];
  const memory = new EngineMemory({
    enabled: true, tickMs: options.tickMs ?? 5,
    read: (): HostMemory => ({ totalBytes: 4 * GB, availableBytes: Math.max(0, state.available - children.size * perEngine), swapFreeBytes: 0, oomKills, fullStall10: state.fullStall10 }),
    groups: () => new Map([...children.keys()].map((pid) => [pid, perEngine])),
    now: () => clock,
    signal: (pid, signal) => {
      signals.push(`${signal} -${pid}`);
      const child = children.get(-(-pid));
      if (child && child.exitCode === null && child.signalCode === null) queueMicrotask(() => child.exit(signal));
    },
    log: (line) => logs.push(line),
  });
  let nextPid = 1000;
  /** A turn on this thread starts its engine: tracked as spawnCli does inside the turn. */
  const spawn = (threadId: string) => memory.within(threadId, () => {
    const child = new FakeChild(nextPid++);
    children.set(child.pid, child);
    child.once("exit", () => children.delete(child.pid));
    memory.track(child as unknown as ChildProcess);
    return child;
  });
  return { memory, state, children, signals, logs, spawn, advance: (ms: number) => { clock += ms; }, oomKill: () => { oomKills++; } };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("admitting engines", () => {
  it("lets engines start while they fit, then makes the next one wait, saying so, until one finishes", async () => {
    const h = host();
    const started: string[] = [];
    const notices: string[] = [];
    // 3.4 GB free less the 410 MB kept back: four engines of 700 MB fit, counting those still starting.
    for (const thread of ["a", "b", "c", "d"]) {
      expect(await h.memory.admit(thread, new AbortController().signal, (text) => notices.push(text))).toBe(true);
      h.memory.turnStarted(thread);
      h.spawn(thread);
      started.push(thread);
    }
    expect(notices).toEqual([]);
    const fifth = h.memory.admit("e", new AbortController().signal, (text) => notices.push(text));
    await settle();
    expect(notices).toEqual([memoryWaitText(4)]);
    expect(notices[0]).toBe("Waiting for memory: 4 tasks are running on this Cloud, and one more could run it out of memory. This one starts by itself when there is room.");
    // Ten minutes on, it says so again, so the turn never looks stalled.
    h.advance(10 * 60_000);
    await settle();
    expect(notices).toEqual([memoryWaitText(4), memoryStillWaitingText(4)]);
    // "a" finishes and its engine exits (Codex stops its process after each turn).
    h.memory.turnEnded("a");
    h.children.get(1000)!.exit();
    expect(await fifth).toBe(true);
  });

  it("counts engines admitted but not started yet, so a burst of five does not all start at once", async () => {
    const h = host();
    for (const thread of ["a", "b", "c", "d"]) expect(await h.memory.admit(thread, new AbortController().signal, () => {})).toBe(true);
    const notices: string[] = [];
    const stop = new AbortController();
    const fifth = h.memory.admit("e", stop.signal, (text) => notices.push(text));
    await settle();
    expect(notices).toEqual([memoryWaitText(4)]);
    stop.abort();
    expect(await fifth).toBe(false);
  });

  it("stops an engine nobody is using to make room, oldest first", async () => {
    const h = host();
    for (const thread of ["a", "b", "c", "d"]) {
      await h.memory.admit(thread, new AbortController().signal, () => {});
      h.memory.turnStarted(thread);
      h.spawn(thread);
    }
    h.advance(91_000);
    // "b" and "c" finished; their engines stay for the next turn.
    h.memory.turnEnded("c");
    h.memory.turnEnded("b");
    const notices: string[] = [];
    const admitted = h.memory.admit("e", new AbortController().signal, (text) => notices.push(text));
    await settle();
    expect(h.signals).toEqual(["SIGTERM -1001"]);
    expect(await admitted).toBe(true);
    expect(notices).toEqual([]);
    expect(h.memory.hasEngine("b")).toBe(false);
    expect(h.memory.hasEngine("c")).toBe(true);
  });

  it("never holds back the only task, and gives up when stopped", async () => {
    const h = host({ available: 200 * MB });
    expect(await h.memory.admit("a", new AbortController().signal, () => {})).toBe(true);
    h.memory.turnStarted("a");
    h.spawn("a");
    const stop = new AbortController();
    const second = h.memory.admit("b", stop.signal, () => {});
    await settle();
    stop.abort();
    expect(await second).toBe(false);
  });

  it("admits everything where memory can't be read or the gate is off", async () => {
    const off = new EngineMemory({ enabled: false, read: () => { throw new Error("not read when off"); } });
    expect(await off.admit("a", new AbortController().signal, () => { throw new Error("no notice"); })).toBe(true);
    const unknown = new EngineMemory({ enabled: true, read: () => null });
    expect(await unknown.admit("a", new AbortController().signal, () => {})).toBe(true);
  });
});

describe("running short", () => {
  it("stops the newest of the busy engines before the home runs out, and the turn says why", async () => {
    const h = host();
    for (const thread of ["a", "b", "c", "d", "e"]) {
      h.memory.turnStarted(thread);
      h.spawn(thread);
      h.advance(1_000);
    }
    h.state.available = 100 * MB;
    h.memory.tick();
    await settle();
    expect(h.signals).toEqual(["SIGKILL -1004"]);
    expect(h.memory.stopText("e")).toBe(memoryStopText(5));
    expect(memoryStopText(5)).toBe("This Cloud ran out of memory while 5 tasks ran at once, so this one was stopped. It was not a problem with the AI provider. New tasks now wait until there is memory for them.");
    // Within the cooldown, the next tick stops nothing more.
    h.memory.tick();
    await settle();
    expect(h.signals).toHaveLength(1);
    // The others ran short too: a stall among them says memory was the reason.
    expect(h.memory.stallCause("a", "no activity for 20 minutes — the turn was stopped"))
      .toBe("no activity for 20 minutes — the turn was stopped. This Cloud ran out of memory while 5 tasks ran at once (not a problem with the AI provider)");
    h.memory.turnEnded("a");
    expect(h.memory.stallCause("a", "x")).toBe("x");
  });

  it("stops an idle engine first, and never the only busy one", async () => {
    const h = host();
    h.memory.turnStarted("a"); h.spawn("a");
    h.memory.turnStarted("b"); h.spawn("b");
    h.memory.turnEnded("b");
    h.state.available = 100 * MB;
    h.memory.tick();
    await settle();
    expect(h.signals).toEqual(["SIGTERM -1001"]);
    expect(h.memory.stopText("b")).toBeNull();
    h.advance(20_000);
    h.memory.tick();
    await settle();
    expect(h.signals).toHaveLength(1);
    expect(h.memory.stopText("a")).toBeNull();
  });

  it("lets the memory the kernel's OOM killer just freed come back before stopping anything itself", async () => {
    const h = host({ tickMs: 60_000 });
    for (const thread of ["a", "b", "c"]) { h.memory.turnStarted(thread); h.spawn(thread); h.advance(1_000); }
    h.memory.tick();
    h.state.available = 100 * MB;
    h.oomKill();
    h.memory.tick();
    await settle();
    expect(h.signals).toEqual([]);
    h.memory.tick();
    await settle();
    expect(h.signals).toEqual(["SIGKILL -1002"]);
  });

  it("names memory when the kernel's OOM killer took an engine", () => {
    const h = host();
    h.memory.turnStarted("a"); const a = h.spawn("a");
    h.memory.turnStarted("b"); h.spawn("b");
    h.oomKill();
    a.exit("SIGKILL");
    expect(h.memory.stopText("a")).toBe(memoryStopText(2));
    // A kill without the kernel's count moving (someone's kill -9) is not memory.
    const c = (h.memory.turnStarted("c"), h.spawn("c"));
    c.exit("SIGKILL");
    expect(h.memory.stopText("c")).toBeNull();
  });
});

describe("bots' browsers", () => {
  /** Threads whose bot may browse and whose browser is not running yet, and the threads whose browser was told to close. */
  function browsers(h: ReturnType<typeof host>, starting: Iterable<string>) {
    const pending = new Set(starting), closed: string[] = [];
    h.memory.useBrowsers({ starts: (threadId) => pending.has(threadId), stopped: (threadId) => closed.push(threadId) });
    return { pending, closed };
  }

  it("counts the browser a turn may start, so a burst of browsing turns waits before the home runs out", async () => {
    const h = host();
    browsers(h, ["a", "b", "c"]);
    // 3.4 GB free less the 410 MB kept back: two engines with a browser each fit, not four engines.
    for (const thread of ["a", "b"]) {
      expect(await h.memory.admit(thread, new AbortController().signal, () => {})).toBe(true);
      h.memory.turnStarted(thread);
      h.spawn(thread);
    }
    const notices: string[] = [];
    const stop = new AbortController();
    const third = h.memory.admit("c", stop.signal, (text) => notices.push(text));
    await settle();
    expect(notices).toEqual([memoryWaitText(2)]);
    stop.abort();
    expect(await third).toBe(false);
  });

  it("stops holding a browser's share once it has run a while, where what it takes shows in free memory", async () => {
    const h = host();
    const { pending } = browsers(h, ["a", "b", "c"]);
    for (const thread of ["a", "b"]) {
      await h.memory.admit(thread, new AbortController().signal, () => {});
      h.memory.turnStarted(thread);
      h.spawn(thread);
    }
    let admitted = false;
    const third = h.memory.admit("c", new AbortController().signal, () => {}).then((ok) => { admitted = ok; });
    await settle();
    // Both browsers started on a light page: 100 MB each, not the 400 MB held for each.
    pending.delete("a"); pending.delete("b");
    h.state.available -= 200 * MB;
    await settle();
    // Just started, a browser may still grow: its share stays held.
    expect(admitted).toBe(false);
    h.advance(30_000);
    await third;
    expect(admitted).toBe(true);
    expect(BROWSER_BYTES).toBe(400 * MB);
  });

  it("closes the browser of a turn stopped for memory, and leaves an idle engine's alone", async () => {
    const h = host();
    const { closed } = browsers(h, []);
    for (const thread of ["a", "b", "c"]) { h.memory.turnStarted(thread); h.spawn(thread); h.advance(1_000); }
    h.memory.turnStarted("d"); h.spawn("d");
    h.memory.turnEnded("d");
    h.state.available = 100 * MB;
    h.memory.tick();
    await settle();
    expect(h.signals).toEqual(["SIGTERM -1003"]);
    expect(closed).toEqual([]);
    h.advance(20_000);
    h.memory.tick();
    await settle();
    expect(h.signals).toEqual(["SIGTERM -1003", "SIGKILL -1002"]);
    expect(closed).toEqual(["c"]);
  });

  it("closes the browser of a turn the kernel's OOM killer stopped", () => {
    const h = host();
    const { closed } = browsers(h, []);
    h.memory.turnStarted("a"); const a = h.spawn("a");
    h.memory.turnStarted("b"); h.spawn("b");
    h.oomKill();
    a.exit("SIGKILL");
    expect(closed).toEqual(["a"]);
  });
});

function fakeInstance(driverKind = "opencodeGo") {
  const listeners = new Set<RuntimeEventListener>();
  const sent: string[] = [];
  let modelsRead = 0;
  const instance = {
    instanceId: "i1", driverKind, displayName: "x", enabled: true,
    get models() { modelsRead++; return { default: "m", options: [] }; },
    snapshot: async () => ({ state: "available" as const }),
    dispose: async () => {},
    adapter: {
      provider: driverKind,
      capabilities: { sessionModelSwitch: "unsupported" as const },
      sendTurn: async (input: SendTurnInput) => { sent.push(input.threadId); return { turnId: `turn-${input.threadId}` }; },
      interruptTurn: async () => {},
      respondToRequest: async () => "unavailable" as const,
      hasSession: () => false,
      stopAll: async () => {},
      onEvent: (listener: RuntimeEventListener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    },
  } as unknown as ProviderInstance;
  const emit = (event: Partial<RuntimeEvent>) => { for (const listener of listeners) listener({ eventId: "e", provider: driverKind, createdAt: "", ...event } as RuntimeEvent); };
  return { instance, sent, emit, modelsRead: () => modelsRead };
}

describe("an engine's adapter on a Cloud home", () => {
  it("tells the chat a turn waits for memory, and a Stop while it waits starts nothing", async () => {
    const h = host({ available: 300 * MB });
    h.memory.turnStarted("busy"); h.spawn("busy");
    const { instance, sent } = fakeInstance();
    const decorated = withEngineMemory(instance, h.memory);
    expect(decorated).toBe(instance);
    const seen: RuntimeEvent[] = [];
    decorated.adapter.onEvent((event) => seen.push(event));
    const turn = decorated.adapter.sendTurn({ threadId: "t1", text: "hi" } as SendTurnInput);
    await settle();
    expect(seen).toEqual([expect.objectContaining({ type: "runtime.notice", threadId: "t1", provider: "opencodeGo", message: memoryWaitText(1) })]);
    await decorated.adapter.interruptTurn("t1");
    await expect(turn).rejects.toBeInstanceOf(TurnNotStartedError);
    expect(sent).toEqual([]);
  });

  it("starts at once when the thread's engine is still running, and keeps the instance's live getters", async () => {
    const h = host({ available: 100 * MB });
    h.memory.turnStarted("busy"); h.spawn("busy");
    h.memory.turnStarted("t1"); h.spawn("t1"); h.memory.turnEnded("t1");
    const fake = fakeInstance();
    const decorated = withEngineMemory(fake.instance, h.memory);
    expect(await decorated.adapter.sendTurn({ threadId: "t1", text: "again" } as SendTurnInput)).toEqual({ turnId: "turn-t1" });
    expect(fake.sent).toEqual(["t1"]);
    void decorated.models; void decorated.models;
    expect(fake.modelsRead()).toBe(2);
  });

  it("fails a turn stopped for memory with that reason, and adds it when the engine said nothing", async () => {
    const h = host();
    const fake = fakeInstance();
    const decorated = withEngineMemory(fake.instance, h.memory);
    const seen: RuntimeEvent[] = [];
    decorated.adapter.onEvent((event) => seen.push(event));
    await decorated.adapter.sendTurn({ threadId: "a", text: "1" } as SendTurnInput);
    await decorated.adapter.sendTurn({ threadId: "b", text: "2" } as SendTurnInput);
    h.spawn("a"); h.advance(1_000); h.spawn("b");
    h.state.available = 50 * MB;
    h.memory.tick();
    await settle();
    fake.emit({ threadId: "b", turnId: "tb", type: "runtime.error", message: "opencodeGo exited null before the prompt result" });
    fake.emit({ threadId: "b", turnId: "tb", type: "turn.completed", ok: false, stopReason: "exit_before_result" });
    await settle();
    expect(seen.map((event) => event.type === "runtime.error" ? event.message : event.type)).toEqual([
      `${memoryStopText(2)} (opencodeGo exited null before the prompt result)`, "turn.completed"]);
    expect(h.memory.stopText("b")).toBeNull();
    // An engine that ends its turn without an error of its own: the reason comes first.
    h.oomKill();
    h.children.get(1000)!.exit("SIGKILL");
    fake.emit({ threadId: "a", turnId: "ta", type: "turn.completed", ok: false, stopReason: "exit_before_result" });
    expect(seen.slice(2).map((event) => event.type === "runtime.error" ? event.message : event.type)).toEqual([memoryStopText(1), "turn.completed"]);
  });

  it("leaves engines that start no process of their own, and every engine where the gate is off, as they are", () => {
    const h = host();
    const api = fakeInstance("openai-compat");
    const adapter = api.instance.adapter;
    expect(withEngineMemory(api.instance, h.memory).adapter).toBe(adapter);
    const local = fakeInstance();
    const localAdapter = local.instance.adapter;
    expect(withEngineMemory(local.instance, new EngineMemory({ enabled: false })).adapter).toBe(localAdapter);
  });
});

describe("engines that run several threads' sessions", () => {
  it("composes existing admission with native execution cancellation while waiting for memory", async () => {
    const h = host({ available: 300 * MB });
    h.memory.turnStarted("busy"); h.spawn("busy");
    const fake = fakeInstance("codex");
    fake.instance.adapter.capabilities.engineAdmission = true;
    let forwarded: SendTurnInput | undefined;
    fake.instance.adapter.sendTurn = async (input) => { forwarded = input; return { turnId: "memory-turn" }; };
    const decorated = withEngineMemory(fake.instance, h.memory);
    const calls: string[] = [];
    const controller = new AbortController();
    const context = { attemptId: "office-attempt", signal: controller.signal, deadline: Date.now() + 60_000,
      assert: () => { calls.push("execution"); } };
    await decorated.adapter.sendTurn({ threadId: "office-memory", text: "fixture", executionContext: context,
      engineAdmission: async () => { calls.push("existing"); } });
    expect(forwarded!.executionContext).toBe(context);
    const admitted = forwarded!.engineAdmission!("process");
    await settle();
    expect(calls).toEqual(["existing"]);
    controller.abort();
    await expect(admitted).rejects.toBeInstanceOf(TurnNotStartedError);
    expect(calls).toEqual(["existing"]);
  });

  it("lets a session into a running engine where a whole new engine would not fit", async () => {
    // One busy engine on 1.6 GB: 900 MB free less the 410 MB kept back fits a 200 MB session but not a 700 MB engine.
    const h = host({ available: 1.6 * GB });
    h.memory.turnStarted("a");
    const child = h.spawn("a");
    expect(await h.memory.admit("c", new AbortController().signal, () => {}, "session")).toBe(true);
    h.advance(90_000);
    const notices: string[] = [];
    const stop = new AbortController();
    const process = h.memory.admit("b", stop.signal, (text) => notices.push(text), "process");
    await settle();
    expect(notices).toEqual([memoryWaitText(1)]);
    h.memory.attach(child as unknown as ChildProcess, "c");
    expect(h.memory.hasEngine("c")).toBe(true);
    h.memory.detach(child as unknown as ChildProcess, "c");
    expect(h.memory.hasEngine("c")).toBe(false);
    expect(h.memory.hasEngine("a")).toBe(true);
    stop.abort();
    expect(await process).toBe(false);
  });

  it("never stops the idle engine a thread is joining to make room for that thread, and never holds back the only task", async () => {
    // One idle shared engine and too little memory for even a session.
    const h = host({ available: 900 * MB });
    h.memory.turnStarted("chief");
    const engine = h.spawn("chief");
    h.memory.turnEnded("chief");
    h.memory.turnStarted("w1");
    expect(await h.memory.admit("w1", new AbortController().signal, () => {}, "session", engine.pid)).toBe(true);
    expect(h.signals).toEqual([]);
    h.memory.turnStarted("w2");
    const notices: string[] = [];
    const stop = new AbortController();
    const second = h.memory.admit("w2", stop.signal, (text) => notices.push(text), "session", engine.pid);
    await settle();
    expect([notices, h.signals]).toEqual([[memoryWaitText(1)], []]);
    stop.abort();
    expect(await second).toBe(false);
  });

  it("stops a shared engine only as a whole, names memory for every task it ran, and counts it idle only when all are done", async () => {
    const h = host();
    h.memory.turnStarted("x"); h.spawn("x");
    h.advance(1_000);
    for (const thread of ["s1", "s2"]) h.memory.turnStarted(thread);
    const shared = h.spawn("s1");
    h.memory.attach(shared as unknown as ChildProcess, "s2");
    expect(h.memory.busy()).toBe(3);
    h.state.available = 1.5 * GB;
    h.memory.tick();
    await settle();
    expect(h.signals).toEqual([`SIGKILL -${shared.pid}`]);
    expect([h.memory.stopText("s1"), h.memory.stopText("s2"), h.memory.stopText("x")]).toEqual([memoryStopText(3), memoryStopText(3), null]);

    const g = host();
    for (const thread of ["s1", "s2"]) g.memory.turnStarted(thread);
    const engine = g.spawn("s1");
    g.memory.attach(engine as unknown as ChildProcess, "s2");
    g.memory.turnEnded("s1");
    g.state.available = 800 * MB;
    g.memory.tick();
    await settle();
    expect(g.signals).toEqual([]);
    g.memory.turnEnded("s2");
    g.memory.tick();
    await settle();
    expect(g.signals).toEqual([`SIGTERM -${engine.pid}`]);
  });

  it("hands admission to a driver that starts or joins engines itself, instead of holding its turn up front", async () => {
    const h = host({ available: 300 * MB });
    h.memory.turnStarted("busy"); h.spawn("busy");
    const fake = fakeInstance();
    (fake.instance.adapter.capabilities as { engineAdmission?: boolean }).engineAdmission = true;
    let admission: SendTurnInput["engineAdmission"];
    const sendTurn = fake.instance.adapter.sendTurn;
    (fake.instance.adapter as { sendTurn: typeof sendTurn }).sendTurn = async (input) => { admission = input.engineAdmission; return sendTurn(input); };
    const decorated = withEngineMemory(fake.instance, h.memory);
    const seen: RuntimeEvent[] = [];
    decorated.adapter.onEvent((event) => seen.push(event));
    expect(await decorated.adapter.sendTurn({ threadId: "t1", text: "hi" } as SendTurnInput)).toEqual({ turnId: "turn-t1" });
    expect(fake.sent).toEqual(["t1"]);
    const waiting = admission!("process");
    await settle();
    expect(seen).toEqual([expect.objectContaining({ type: "runtime.notice", threadId: "t1", message: memoryWaitText(1) })]);
    await decorated.adapter.interruptTurn("t1");
    await expect(waiting).rejects.toBeInstanceOf(TurnNotStartedError);
  });
});

it("words a stall the same way the Cloud's health report classifies it", () => {
  expect(memoryStallText("no activity for 20 minutes — the turn was stopped", 1)).toMatch(/ran out of memory while 1 task ran at once/);
});
