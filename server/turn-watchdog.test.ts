import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import { chatNotice, failedNoticeTool } from "./chat-notices.ts";
import type { ProviderAdapter, RuntimeEvent } from "./contracts.ts";
import { EngineMemory } from "./engine-memory.ts";
import type { Message } from "./store.ts";
import { TurnStops, stoppedTurnOutcome } from "./turn-outcome.ts";
import { engineCommandCpuMs, engineProcessGone, stallLimitMs, stallNotice, stuckCommand, TurnWatchdog, type TurnWatchdogOptions, type WatchedTurn } from "./turn-watchdog.ts";

const STALL = 10_000;
const TOOL_STALL = 50_000;
const PARKED_STALL = 1_000 * STALL;
const base = { eventId: "e1", provider: "claudeAgent", threadId: "t1", createdAt: "2026-01-01T00:00:00.000Z" };
const text: RuntimeEvent = { ...base, type: "content.delta", streamKind: "assistant_text", delta: "working" };
const toolStarted = (itemId: string): RuntimeEvent => ({ ...base, type: "item.started", itemType: "tool", itemId });
const shellStarted = (itemId: string, summary: string): RuntimeEvent => ({ ...base, type: "item.started", itemType: "tool", itemId, title: "Bash", summary });
const toolEnded = (itemId: string): RuntimeEvent => ({ ...base, type: "item.completed", itemType: "tool", itemId, ok: true });

function rig(extra: Partial<TurnWatchdogOptions> = {}) {
  let now = 0;
  const stalls: WatchedTurn[] = [];
  const limits: number[] = [];
  const adapters = new Map<string, Pick<ProviderAdapter, "enginePid">>();
  const alive = new Set<number>();
  const working: Array<{ threadId: string; botId: string }> = [];
  const freed: string[] = [];
  const dog = new TurnWatchdog({
    stallMs: STALL,
    toolStallMs: TOOL_STALL,
    parkedStallMs: PARKED_STALL,
    checkMs: 60_000,
    engineGone: (turn) => engineProcessGone(adapters.get(turn.threadId), turn.threadId, (pid) => alive.has(pid)),
    onStall: (turn, silentMs) => { stalls.push(turn); limits.push(silentMs); },
    unheld: {
      threads: () => [...working],
      free: (threadId) => { freed.push(threadId); working.splice(working.findIndex((thread) => thread.threadId === threadId), 1); },
    },
    now: () => now,
    ...extra,
  });
  return { dog, stalls, limits, adapters, alive, working, freed, tick: (ms: number) => (now += ms) };
}

const ENGINE_PID = 4242;
/** A driver that tracks its engine process: it names one while the turn is active, and none once it is not. */
const tracked = (pid: number | undefined): Pick<ProviderAdapter, "enginePid"> => ({ enginePid: () => pid });

describe("TurnWatchdog", () => {
  it("stalls a silent turn once, and only once", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    tick(STALL - 1);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    tick(2);
    dog.sweep();
    expect(stalls).toEqual([expect.objectContaining({ threadId: "t1", botId: "bot1" })]);
    dog.sweep();
    expect(stalls).toHaveLength(1);
    expect(dog.watching("t1")).toBe(false);
  });

  it("any event on the thread resets the clock", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    for (let i = 0; i < 10; i++) {
      tick(STALL - 1);
      dog.observe(text);
    }
    dog.sweep();
    expect(stalls).toHaveLength(0);
  });

  it("never stalls a turn waiting on a human while its engine may still run it, however long they take", () => {
    const engines: Array<[string, Pick<ProviderAdapter, "enginePid"> | undefined]> = [
      ["no engine known", undefined],
      // An in-process engine (the OpenAI-compatible ask_user path) names no process: that proves nothing about its turn.
      ["an engine that names no process", {}],
      ["an engine whose process runs", tracked(ENGINE_PID)],
    ];
    for (const [name, adapter] of engines) {
      const { dog, stalls, adapters, alive, tick } = rig();
      if (adapter) adapters.set("t1", adapter);
      alive.add(ENGINE_PID);
      dog.watch("t1", "bot1");
      dog.setWaitingOnHuman("t1", true);
      tick(PARKED_STALL * 2);
      dog.sweep();
      expect(stalls, name).toHaveLength(0);
      dog.setWaitingOnHuman("t1", false);
      tick(STALL - 1);
      dog.sweep();
      expect(stalls, name).toHaveLength(0);
      tick(2);
      dog.sweep();
      expect(stalls, name).toHaveLength(1);
    }
  });

  it("stops a parked turn whose engine is known to be gone, once it has been silent past the parked limit", () => {
    for (const park of ["human", "computer"] as const) {
      for (const [name, adapter] of [["no process tracked for the turn", tracked(undefined)], ["its process exited", tracked(ENGINE_PID)]] as const) {
        const { dog, stalls, limits, adapters, tick } = rig();
        adapters.set("t1", adapter);
        dog.watch("t1", "bot1");
        if (park === "human") dog.setWaitingOnHuman("t1", true);
        else dog.setWaitingOnComputer("t1", true);
        tick(PARKED_STALL - 1);
        dog.sweep();
        expect(stalls, `${park}, ${name}`).toHaveLength(0);
        expect(dog.answering("bot1"), park).toBe(false);
        tick(2);
        dog.sweep();
        expect(stalls, `${park}, ${name}`).toEqual([expect.objectContaining({ threadId: "t1", botId: "bot1" })]);
        expect(limits, `${park}, ${name}`).toEqual([PARKED_STALL]);
        expect(dog.watching("t1"), park).toBe(false);
      }
    }
  });

  it("stops a turn that waited long on a live engine as soon as that engine's process exits", () => {
    const { dog, stalls, limits, adapters, alive, tick } = rig();
    adapters.set("t1", tracked(ENGINE_PID));
    alive.add(ENGINE_PID);
    dog.watch("t1", "bot1");
    dog.setWaitingOnHuman("t1", true);
    tick(PARKED_STALL * 3);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    alive.delete(ENGINE_PID);
    dog.sweep();
    expect(limits).toEqual([PARKED_STALL]);
  });

  it("reads an engine as gone only when its driver tracks a process and that process is not there", () => {
    expect(engineProcessGone(undefined, "t1")).toBe(false);
    expect(engineProcessGone({}, "t1")).toBe(false);
    expect(engineProcessGone(tracked(undefined), "t1")).toBe(true);
    expect(engineProcessGone(tracked(process.pid), "t1")).toBe(false);
    expect(engineProcessGone(tracked(ENGINE_PID), "t1", () => false)).toBe(true);
  });

  it("a settled turn is forgotten", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    dog.settle("t1");
    tick(STALL * 2);
    dog.sweep();
    expect(stalls).toHaveLength(0);
  });

  it("says a turn is waiting exactly while the sweep would spare it", () => {
    const { dog } = rig();
    expect(dog.waiting("t1")).toBe(false);
    dog.watch("t1", "bot1");
    expect(dog.waiting("t1")).toBe(false);
    dog.setWaitingOnHuman("t1", true);
    expect(dog.waiting("t1")).toBe(true);
    dog.setWaitingOnComputer("t1", true);
    dog.setWaitingOnHuman("t1", false);
    expect(dog.waiting("t1")).toBe(true);
    dog.setWaitingOnComputer("t1", false);
    expect(dog.waiting("t1")).toBe(false);
    dog.setWaitingOnHuman("t1", true);
    dog.settle("t1");
    expect(dog.waiting("t1")).toBe(false);
  });

  it("lets the computer wait's own deadline govern, then restarts the stall clock", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    dog.setWaitingOnComputer("t1", true);
    tick(STALL * 100);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    dog.setWaitingOnHuman("t1", false);
    tick(STALL * 100);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    dog.setWaitingOnComputer("t1", false);
    tick(STALL - 1);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    tick(2);
    dog.sweep();
    expect(stalls).toHaveLength(1);
  });

  it("re-watching a thread replaces the previous turn", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    tick(STALL - 1);
    dog.watch("t1", "bot2");
    tick(2);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    tick(STALL);
    dog.sweep();
    expect(stalls).toEqual([expect.objectContaining({ botId: "bot2" })]);
  });

  it("lets a turn stay silent while its tool runs, up to the tool limit", () => {
    const { dog, stalls, limits, tick } = rig();
    dog.watch("t1", "bot1");
    dog.observe(toolStarted("tool-1"));
    tick(TOOL_STALL - 1);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    tick(2);
    dog.sweep();
    expect(stalls).toEqual([expect.objectContaining({ threadId: "t1" })]);
    expect(limits).toEqual([TOOL_STALL]);
  });

  it("goes back to the turn limit once every running tool has ended", () => {
    const { dog, stalls, limits, tick } = rig();
    dog.watch("t1", "bot1");
    dog.observe(toolStarted("tool-1"));
    dog.observe(toolStarted("tool-2"));
    dog.observe(toolEnded("tool-1"));
    tick(STALL * 2);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    dog.observe(toolEnded("tool-2"));
    tick(STALL - 1);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    tick(2);
    dog.sweep();
    expect(limits).toEqual([STALL]);
  });

  it("sets no deadline of its own on a tool while the turn keeps talking", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    dog.observe(toolStarted("long"));
    for (let i = 0; i < 6; i++) {
      tick(TOOL_STALL / 2);
      dog.observe(text);
      dog.sweep();
    }
    expect(stalls).toHaveLength(0);
  });

  it("never carries a running tool into a turn that did not start it", () => {
    const { dog, stalls, limits, tick } = rig();
    dog.observe(toolStarted("early"));
    dog.watch("t1", "bot1");
    dog.observe(toolStarted("tool-1"));
    dog.watch("t1", "bot1");
    tick(STALL);
    dog.sweep();
    expect(stalls).toHaveLength(1);
    expect(limits).toEqual([STALL]);
  });

  it("does not count the time the computer slept as a turn's silence", () => {
    vi.useFakeTimers({ now: 0 });
    const stalls: WatchedTurn[] = [];
    const dog = new TurnWatchdog({ stallMs: STALL, toolStallMs: TOOL_STALL, parkedStallMs: PARKED_STALL, checkMs: 1_000, onStall: (turn) => stalls.push(turn) });
    try {
      dog.start();
      dog.watch("t1", "bot1");
      vi.advanceTimersByTime(STALL / 2);
      // The Mac sleeps for an hour: the process is suspended, so no sweep runs while the wall clock keeps going.
      vi.setSystemTime(Date.now() + 60 * 60_000);
      vi.advanceTimersByTime(1_000);
      expect(stalls).toHaveLength(0);
      vi.advanceTimersByTime(STALL / 2 - 2_000);
      expect(stalls).toHaveLength(0);
      vi.advanceTimersByTime(STALL);
      expect(stalls).toEqual([expect.objectContaining({ threadId: "t1" })]);
    } finally {
      dog.stop();
      vi.useRealTimers();
    }
  });

  it("still counts silence across sweeps that are only a little late", () => {
    vi.useFakeTimers({ now: 0 });
    const stalls: WatchedTurn[] = [];
    const dog = new TurnWatchdog({ stallMs: STALL, toolStallMs: TOOL_STALL, parkedStallMs: PARKED_STALL, checkMs: 1_000, onStall: (turn) => stalls.push(turn) });
    try {
      dog.start();
      dog.watch("t1", "bot1");
      vi.advanceTimersByTime(STALL - 3_000);
      vi.setSystemTime(Date.now() + 2_000);
      vi.advanceTimersByTime(1_000);
      expect(stalls).toHaveLength(1);
    } finally {
      dog.stop();
      vi.useRealTimers();
    }
  });

  it("says a bot is answering while one of its turns runs unparked, and not once it waits or ends", () => {
    const { dog } = rig();
    expect(dog.answering("bot1")).toBe(false);
    dog.watch("t1", "bot1");
    dog.watch("t2", "bot2");
    expect(dog.answering("bot1")).toBe(true);
    dog.setWaitingOnHuman("t1", true);
    expect(dog.answering("bot1"), "paused on the person's approval").toBe(false);
    dog.watch("t3", "bot1");
    expect(dog.answering("bot1"), "its other conversation answers").toBe(true);
    dog.setWaitingOnComputer("t3", true);
    expect(dog.answering("bot1"), "waiting for a computer").toBe(false);
    dog.setWaitingOnComputer("t3", false);
    dog.settle("t3");
    expect(dog.answering("bot1")).toBe(false);
    expect(dog.answering("bot2")).toBe(true);
  });

  it("frees a conversation shown working that no turn holds, once it has stayed so for the stall limit", () => {
    const { dog, working, freed, stalls, tick } = rig();
    working.push({ threadId: "t1", botId: "bot1" });
    dog.sweep();
    tick(STALL - 1);
    dog.sweep();
    expect(freed).toEqual([]);
    tick(1);
    dog.sweep();
    expect(freed).toEqual(["t1"]);
    tick(STALL * 2);
    dog.sweep();
    expect(freed).toEqual(["t1"]);
    expect(stalls).toEqual([]);
  });

  it("leaves a conversation to the turn it watches, and counts from that turn's end", () => {
    const { dog, working, freed, tick } = rig();
    dog.watch("t1", "bot1");
    working.push({ threadId: "t1", botId: "bot1" });
    dog.setWaitingOnHuman("t1", true);
    dog.sweep();
    tick(STALL * 3);
    dog.sweep();
    expect(freed).toEqual([]);
    dog.settle("t1");
    dog.sweep();
    tick(STALL - 1);
    dog.sweep();
    expect(freed).toEqual([]);
    tick(1);
    dog.sweep();
    expect(freed).toEqual(["t1"]);
  });

  it("counts again from the start for a conversation that went back to being held in between", () => {
    const { dog, working, freed, tick } = rig();
    working.push({ threadId: "t1", botId: "bot1" });
    dog.sweep();
    tick(STALL - 1);
    working.pop();
    dog.sweep();
    working.push({ threadId: "t1", botId: "bot1" });
    tick(1);
    dog.sweep();
    tick(STALL - 1);
    dog.sweep();
    expect(freed).toEqual([]);
    tick(1);
    dog.sweep();
    expect(freed).toEqual(["t1"]);
  });
});

describe("a shell command that keeps working", () => {
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  /** Sweeps once a turn limit at a time for ms, letting each CPU read land before the next sweep. */
  async function run(r: ReturnType<typeof rig>, ms: number) {
    for (let left = ms; left > 0; left -= STALL) {
      r.tick(Math.min(STALL, left));
      r.dog.sweep();
      await settle();
    }
  }

  it("is never stopped while its processes keep using CPU, and is once they stop for the tool limit", async () => {
    let cpuMs = 0, busy = true;
    const reads: number[] = [];
    const r = rig({ commandCpuMs: async (_turn, since) => { reads.push(since); if (busy) cpuMs += 1_000; return cpuMs; } });
    r.dog.watch("t1", "bot1");
    r.tick(5);
    r.dog.observe(shellStarted("tool-1", "ffmpeg -i talk.mov talk.mp4"));
    await run(r, 5 * TOOL_STALL);
    expect(r.stalls).toHaveLength(0);
    expect(new Set(reads)).toEqual(new Set([5]));
    busy = false;
    await run(r, TOOL_STALL - STALL);
    expect(r.stalls).toHaveLength(0);
    await run(r, 2 * STALL);
    expect(r.stalls).toEqual([expect.objectContaining({ threadId: "t1" })]);
    expect(r.limits).toEqual([TOOL_STALL]);
    expect(stallNotice(r.stalls[0]!, TOOL_STALL, 6 * TOOL_STALL + 5).key).toBe("chat.notice.stalledCommand");
  });

  it("is stopped at the tool limit when its processes use no CPU, or their CPU time cannot be read", async () => {
    for (const cpuMs of [500, null]) {
      const r = rig({ commandCpuMs: async () => cpuMs });
      r.dog.watch("t1", "bot1");
      r.dog.observe(shellStarted("tool-1", "sleep 100000"));
      await run(r, TOOL_STALL - 1);
      expect(r.stalls).toHaveLength(0);
      await run(r, 2);
      expect(r.limits).toEqual([TOOL_STALL]);
    }
  });

  it("reads nothing until the turn has been silent for the turn limit, nor for a tool that runs no shell command", async () => {
    let reads = 0;
    const r = rig({ commandCpuMs: async () => (reads += 1) });
    r.dog.watch("t1", "bot1");
    r.dog.observe(toolStarted("tool-1"));
    await run(r, TOOL_STALL - 1);
    expect(reads).toBe(0);
    r.dog.observe(toolEnded("tool-1"));
    r.dog.observe(shellStarted("tool-2", "make build"));
    await run(r, STALL - 1);
    expect(reads).toBe(0);
    await run(r, 1);
    expect(reads).toBe(1);
  });

  it("counts processes coming and going as work, and is not misled by a read that failed", async () => {
    const seen = [300, null, 200, 400, null, 100];
    let reads = 0;
    const r = rig({ commandCpuMs: async () => seen[reads++ % seen.length] ?? null });
    r.dog.watch("t1", "bot1");
    r.dog.observe(shellStarted("tool-1", "make -j8"));
    await run(r, 3 * TOOL_STALL);
    expect(r.stalls).toHaveLength(0);
  });

  it("goes on with the next sweep when reading a command's CPU time throws", async () => {
    const r = rig({ commandCpuMs: () => { throw new Error("thread gone"); } });
    r.dog.watch("t1", "bot1");
    r.dog.observe(shellStarted("tool-1", "make build"));
    await run(r, TOOL_STALL);
    expect(r.limits).toEqual([TOOL_STALL]);
  });

  it("never compares one command's CPU time with another's", async () => {
    const r = rig({ commandCpuMs: async (_turn, since) => (since === 0 ? 100 : 5_000) });
    r.dog.watch("t1", "bot1");
    r.dog.observe(shellStarted("tool-1", "make build"));
    await run(r, TOOL_STALL - STALL);
    r.dog.observe(shellStarted("tool-2", "make test"));
    r.dog.observe(toolEnded("tool-1"));
    await run(r, TOOL_STALL);
    expect(r.limits).toEqual([TOOL_STALL]);
  });

  it("reads the CPU time of what the engine started since the command did, and nothing for a driver with no process", async () => {
    const sample = vi.fn(async () => ({ cpuMs: 1_234, connections: null }));
    expect(await engineCommandCpuMs(tracked(ENGINE_PID), "t1", 99, sample)).toBe(1_234);
    expect(sample).toHaveBeenCalledWith(ENGINE_PID, 99);
    expect(await engineCommandCpuMs(tracked(undefined), "t1", 99, sample)).toBeNull();
    expect(await engineCommandCpuMs({}, "t1", 99, sample)).toBeNull();
    expect(await engineCommandCpuMs(undefined, "t1", 99, sample)).toBeNull();
    expect(sample).toHaveBeenCalledTimes(1);
  });
});

describe("stuckCommand", () => {
  it("names the longest-running shell command still running when the turn is stopped", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    dog.observe(toolStarted("read"));
    tick(1_000);
    dog.observe(shellStarted("export", "ffmpeg -i talk.mov talk.mp4"));
    tick(1_000);
    dog.observe(shellStarted("done", "ls"));
    dog.observe(toolEnded("done"));
    tick(TOOL_STALL);
    dog.sweep();
    expect(stalls).toHaveLength(1);
    expect(stuckCommand(stalls[0]!, 1_000 + 120 * 60_000)).toEqual({ command: "ffmpeg -i talk.mov talk.mp4", minutes: 120 });
  });

  it("scrubs a secret in the command it names", () => {
    const { dog, stalls, tick } = rig();
    const token = "sk-ant-api03-" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6";
    dog.watch("t1", "bot1");
    dog.observe(shellStarted("upload", `curl -H "Authorization: Bearer ${token}" https://example.com/upload`));
    tick(TOOL_STALL);
    dog.sweep();
    const stuck = stuckCommand(stalls[0]!, TOOL_STALL);
    expect(stuck?.command).toContain("curl -H");
    expect(stuck?.command).not.toContain(token);
    expect(JSON.stringify(stallNotice(stalls[0]!, TOOL_STALL, TOOL_STALL))).not.toContain(token);
  });

  it("names nothing when no running tool runs a shell command", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    dog.observe(toolStarted("fetch"));
    dog.observe(shellStarted("ended", "make build"));
    dog.observe(toolEnded("ended"));
    tick(TOOL_STALL);
    dog.sweep();
    expect(stuckCommand(stalls[0]!, TOOL_STALL)).toBeNull();
    expect(stuckCommand({}, 0)).toBeNull();
  });
});

// The harness's stall handler (index.ts), run without starting a server.
describe("the stall handler", () => {
  function load(engineMemory = new EngineMemory({ enabled: false }), env: Record<string, string> = {}) {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const from = source.indexOf("\nconst TURN_STALL_MS"), to = source.indexOf("\nwatchdog.start();");
    if (from < 0 || to <= from) throw new Error("Stall handler section moved");
    const code = ts.transpileModule(`${source.slice(from, to)}\nglobalThis.watchdog = watchdog;`,
      { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
    const messages: Message[] = [
      { id: "a", role: "bot", kind: "activity", at: 1, turnId: "turn-1", tool: { name: "Bash", ok: true, itemId: "i1" } } as Message,
      { id: "b", role: "bot", kind: "text", at: 2, turnId: "turn-1", text: "Exporting the second half now." } as Message,
    ];
    const settled: Array<{ generation?: string; text: string }> = [], delegations: string[] = [];
    const context = vm.createContext({
      process: { env },
      RoomTurnStallRegistry: class { stall() {} },
      TurnStops, stoppedTurnOutcome, reportsToRequester: () => true, stallLimitMs,
      TurnWatchdog: class { options: unknown; constructor(options: { onStall: (turn: WatchedTurn) => void }) { this.options = options; } },
      store: { messagesFor: () => messages, activePath: () => messages, appendMessage() {} },
      turnResourceOwners: new Map(), directTurnGenerationByThread: new Map([["t1", "gen-1"]]), directRequestOwners: new Map(),
      localVmThreadTargets: new Map(), liveTurnByThread: new Map([["t1", "turn-1"]]), turnUsage: new Map(), turnContext: new Map(),
      cancelDirectTurnDispatch() {}, revokeInternalCapabilitiesForThread() {}, repeats: { settle() {} },
      botForThread: () => ({ id: "eli" }), activeRoutineRunForThread: () => undefined,
      runningTurnInstance: () => ({ adapter: { interruptTurn: async () => {} } }),
      failedTurnTool: (name: string) => ({ name, ok: false }), chatNotice, failedNoticeTool, stallNotice, reportIncident() {},
      settleDirectFollowup: (generation: string | undefined, outcome: { text: string }) => settled.push({ generation, text: outcome.text }),
      finalizeDelegationWatch: (_threadId: string, _ok: boolean, _reply: string, why: string) => delegations.push(why),
      setTimeout: () => ({ unref() {} }),
      engineMemory,
    });
    vm.runInContext(code, context, { filename: "index.ts (stall handler fixture)" });
    return { context, settled, delegations };
  }

  it("tells a stalled turn's requester why it stopped and what it did", () => {
    const { context, settled, delegations } = load();
    context.watchdog.options.onStall({ threadId: "t1", botId: "eli" }, 20 * 60_000);
    const told = 'No activity for 20 minutes — the turn was stopped. Before it stopped it made 1 tool call: Bash ×1.\nIts last message, quoted: "Exporting the second half now."';
    expect(settled).toEqual([{ generation: "gen-1", text: told }]);
    expect(delegations).toEqual([]);
  });

  it("names the silence that stopped a turn whose tool was running", () => {
    const { context, settled } = load();
    context.watchdog.options.onStall({ threadId: "t1", botId: "eli" }, 120 * 60_000);
    expect(settled[0]!.text).toMatch(/^No activity for 120 minutes — the turn was stopped\. Before it stopped/);
  });

  it("names the shell command that was still running and how long it ran", () => {
    const { context, settled } = load();
    const startedAt = Date.now() - 120 * 60_000;
    const runningTools = new Map([["i1", { startedAt, command: "ffmpeg -i talk.mov talk.mp4" }]]);
    context.watchdog.options.onStall({ threadId: "t1", botId: "eli", runningTools }, 120 * 60_000);
    expect(settled[0]!.text).toMatch(/^The command `ffmpeg -i talk\.mov talk\.mp4` ran for 120 minutes without finishing and looks stuck — the turn was stopped\. Before it stopped/);
  });

  it("never lets the environment switch the watchdog off", () => {
    for (const endless of ["Infinity", "1e309", "-Infinity"]) {
      const { context } = load(undefined, { OMB_TURN_STALL_MS: endless, OMB_TOOL_STALL_MS: endless });
      expect(context.watchdog.options).toMatchObject({ stallMs: 20 * 60_000, toolStallMs: 2 * 60 * 60_000 });
    }
    const { context } = load(undefined, { OMB_TURN_STALL_MS: "3900000", OMB_TOOL_STALL_MS: "1e309" });
    expect(context.watchdog.options).toMatchObject({ stallMs: 3_900_000, toolStallMs: 2 * 60 * 60_000 });
  });

  it("says when the Cloud ran out of memory while the stalled turn ran", () => {
    const memory = new EngineMemory({ enabled: true, read: () => ({ totalBytes: 4 * 1024 ** 3, availableBytes: 0, swapFreeBytes: 0, oomKills: 0, fullStall10: 60 }),
      groups: () => new Map(), log: () => {} });
    memory.turnStarted("t1");
    memory.tick();
    const { context, settled } = load(memory);
    context.watchdog.options.onStall({ threadId: "t1", botId: "eli" }, 20 * 60_000);
    expect(settled[0]!.text).toMatch(/^No activity for 20 minutes — the turn was stopped\. This Cloud ran out of memory while 1 task ran at once \(not a problem with the AI provider\)\. Before it stopped/);
  });

  it("gives a stopped turn's own end the cause the harness noted before interrupting it", () => {
    const { context } = load();
    expect(context.stoppedTurnText("t1", "turn-1", undefined, "interrupted")).toMatch(/^The turn did not complete \(interrupted\)\. /);
    vm.runInContext('turnStops.stopping("t1", "turn-1", "turn interrupted — the Company connection changed")', context);
    expect(context.stoppedTurnText("t1", "turn-1", undefined, "interrupted")).toMatch(/^Turn interrupted — the Company connection changed\. Before it stopped/);
  });
});

// The harness's Stop during provider setup (index.ts), run against a real watchdog without starting a server.
describe("a Stop that wins against a provider dispatch", () => {
  function load(watchdog: TurnWatchdog) {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const section = (from: string, to: string) => {
      const start = source.indexOf(from), end = source.indexOf(to, start);
      if (start < 0 || end <= start) throw new Error(`${from.trim()} moved`);
      return source.slice(start, end);
    };
    const code = ts.transpileModule(section("\nfunction markCancelledProviderHandshake", "\nfunction clearCancelledProviderHandshake") +
      section("\nfunction cancelDirectTurnDispatch", "\nconst {") + "\nglobalThis.cancelDirectTurnDispatch = cancelDirectTurnDispatch;",
    { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
    const quarantined: string[] = [];
    const context = vm.createContext({
      watchdog,
      pendingCancelledProviderHandshakes: { mark: (threadId: string) => quarantined.push(threadId) },
      store: { bot: () => undefined },
      directTurnDispatchClaims: new Map([["t1", { id: "gen-1", botId: "bot1", threadId: "t1", phase: "dispatching" }]]),
      compactionControllers: new Map(), directTurnGenerationByThread: new Map([["t1", "gen-1"]]), clearTurnDigestState() {},
    });
    vm.runInContext(code, context, { filename: "index.ts (dispatch cancel fixture)" });
    return { cancel: (threadId: string) => context.cancelDirectTurnDispatch("bot1", threadId), quarantined };
  }

  it("gives the stopped turn the silence limit, since its quarantined tool can never report its end", () => {
    const r = rig();
    const { cancel, quarantined } = load(r.dog);
    r.dog.watch("t1", "bot1");
    r.dog.observe(toolStarted("tool-1"));
    r.tick(STALL * 2);
    cancel("t1");
    expect(quarantined).toEqual(["t1"]);
    r.tick(STALL - 1);
    r.dog.sweep();
    expect(r.stalls).toHaveLength(0);
    r.tick(2);
    r.dog.sweep();
    expect(r.limits).toEqual([STALL]);
    // The stall handler cancels the dispatch after the sweep dropped the turn: that must not watch it again.
    r.dog.eventsDiscarded("t1");
    expect(r.dog.watching("t1")).toBe(false);
  });
});
