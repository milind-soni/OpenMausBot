import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import type { RuntimeEvent } from "./contracts.ts";
import { EngineMemory } from "./engine-memory.ts";
import type { Message } from "./store.ts";
import { TurnStops, stoppedTurnOutcome } from "./turn-outcome.ts";
import { stallDescription, stallLimitMs, TurnWatchdog, type StallLimit, type WatchedTurn } from "./turn-watchdog.ts";

const STALL = 10_000;
const TOOL_STALL = 50_000;
const base = { eventId: "e1", provider: "claudeAgent", threadId: "t1", createdAt: "2026-01-01T00:00:00.000Z" };
const text: RuntimeEvent = { ...base, type: "content.delta", streamKind: "assistant_text", delta: "working" };
const toolStarted = (itemId: string): RuntimeEvent => ({ ...base, type: "item.started", itemType: "tool", itemId });
const toolEnded = (itemId: string): RuntimeEvent => ({ ...base, type: "item.completed", itemType: "tool", itemId, ok: true });

function rig() {
  let now = 0;
  const stalls: WatchedTurn[] = [];
  const limits: StallLimit[] = [];
  const dog = new TurnWatchdog({
    stallMs: STALL,
    toolStallMs: TOOL_STALL,
    checkMs: 60_000,
    onStall: (turn, limit) => { stalls.push(turn); limits.push(limit); },
    now: () => now,
  });
  return { dog, stalls, limits, tick: (ms: number) => (now += ms) };
}

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

  it("never stalls a turn waiting on a human, however long they take", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    dog.setWaitingOnHuman("t1", true);
    tick(STALL * 100);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    dog.setWaitingOnHuman("t1", false);
    tick(STALL - 1);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    tick(2);
    dog.sweep();
    expect(stalls).toHaveLength(1);
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
    expect(limits).toEqual([{ kind: "tool", ms: TOOL_STALL }]);
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
    expect(limits).toEqual([{ kind: "silence", ms: STALL }]);
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
    expect(limits).toEqual([{ kind: "silence", ms: STALL }]);
  });

  it("stops a hung tool at its own deadline while a parallel tool and text keep the turn busy", () => {
    const { dog, limits, tick } = rig();
    dog.watch("t1", "bot1");
    dog.observe(toolStarted("hung"));
    for (let i = 0; i < 10; i++) {
      dog.observe(toolStarted(`busy-${i}`));
      tick(TOOL_STALL / 10 - 1);
      dog.observe(text);
      dog.observe(toolEnded(`busy-${i}`));
      dog.sweep();
    }
    expect(limits).toEqual([]);
    tick(10);
    dog.observe(text);
    dog.sweep();
    expect(limits).toEqual([{ kind: "tool", ms: TOOL_STALL }]);
  });

  it("keeps a tool's first deadline when its start is reported again", () => {
    const { dog, limits, tick } = rig();
    dog.watch("t1", "bot1");
    dog.observe(toolStarted("tool-1"));
    tick(TOOL_STALL - 1);
    dog.observe(toolStarted("tool-1"));
    tick(1);
    dog.sweep();
    expect(limits).toEqual([{ kind: "tool", ms: TOOL_STALL }]);
  });

  it("does not count a tool's time waiting on a person toward its deadline", () => {
    const { dog, limits, tick } = rig();
    dog.watch("t1", "bot1");
    dog.observe(toolStarted("ask"));
    tick(TOOL_STALL / 2);
    dog.setWaitingOnHuman("t1", true);
    tick(TOOL_STALL / 2);
    dog.sweep();
    dog.setWaitingOnHuman("t1", false);
    tick(TOOL_STALL / 2 - 1);
    dog.observe(text);
    dog.sweep();
    expect(limits).toEqual([]);
    tick(1);
    dog.sweep();
    expect(limits).toEqual([{ kind: "tool", ms: TOOL_STALL }]);
  });

  // Keeps the turn talking every 10 ms and sweeps until the watchdog stops it; returns when.
  interface Rig { dog: TurnWatchdog; limits: StallLimit[]; tick: (ms: number) => number }
  function untilStopped({ dog, limits, tick }: Rig, from: number): number {
    let at = from;
    while (limits.length === 0 && at < from + TOOL_STALL * 3) {
      at = tick(10);
      dog.observe(text);
      dog.sweep();
    }
    return at;
  }

  it("stops a hung tool beside another that keeps waiting on a person, at the cap", () => {
    const { dog, limits, tick } = rig();
    dog.watch("t1", "bot1");
    dog.observe(toolStarted("hung"));
    let at = 0;
    while (limits.length === 0 && at < TOOL_STALL * 10) {
      dog.setWaitingOnHuman("t1", true);
      at = tick(1_000);
      dog.sweep();
      dog.setWaitingOnHuman("t1", false);
      dog.sweep();
    }
    expect({ at, limits, watching: dog.watching("t1") }).toEqual({ at: 2 * TOOL_STALL, limits: [{ kind: "tool-cap", ms: 2 * TOOL_STALL }], watching: false });
  });

  it.each(["setWaitingOnHuman", "setWaitingOnComputer"] as const)("credits a tool started mid-wait only the wait it lived through (%s)", (wait) => {
    const r = rig();
    r.dog.watch("t1", "bot1");
    r.dog[wait]("t1", true);
    r.tick(1_000);
    r.dog.observe(toolStarted("late"));
    r.tick(1);
    r.dog[wait]("t1", false);
    expect(untilStopped(r, 1_001)).toBe(1_001 + TOOL_STALL);
    expect(r.limits).toEqual([{ kind: "tool", ms: TOOL_STALL }]);
  });

  it("stops a tool at the cap while the turn is still waiting", () => {
    const { dog, limits, tick } = rig();
    dog.watch("t1", "bot1");
    dog.observe(toolStarted("ask"));
    dog.setWaitingOnComputer("t1", true);
    tick(2 * TOOL_STALL - 1);
    dog.sweep();
    expect(limits).toEqual([]);
    tick(1);
    dog.sweep();
    expect(limits).toEqual([{ kind: "tool-cap", ms: 2 * TOOL_STALL }]);
    expect(dog.waiting("t1")).toBe(false);
  });

  it("credits overlapping person and computer waits once, and only within the tool's life", () => {
    const r = rig();
    r.dog.watch("t1", "bot1");
    r.dog.setWaitingOnHuman("t1", true);
    r.tick(1_500);
    r.dog.observe(toolStarted("tool-1"));
    r.tick(500);
    r.dog.setWaitingOnComputer("t1", true);
    r.tick(1_000);
    r.dog.setWaitingOnHuman("t1", false);
    r.tick(1_000);
    r.dog.setWaitingOnComputer("t1", false);
    // The person waited 0-3000 and the computer 2000-4000; the tool, started at 1500, waited 1500-4000 once: 2500 ms.
    // Counting each wait apart would credit 3500 ms, and the whole turn's wait 4000 ms.
    expect(untilStopped(r, 4_000)).toBe(1_500 + 2_500 + TOOL_STALL);
    expect(r.limits).toEqual([{ kind: "tool", ms: TOOL_STALL }]);
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
      TurnStops, stoppedTurnOutcome, reportsToRequester: () => true, stallDescription, stallLimitMs,
      TurnWatchdog: class { options: unknown; constructor(options: { onStall: (turn: WatchedTurn) => void }) { this.options = options; } },
      store: { messagesFor: () => messages, activePath: () => messages, appendMessage() {} },
      turnResourceOwners: new Map(), directTurnGenerationByThread: new Map([["t1", "gen-1"]]), directRequestOwners: new Map(),
      localVmThreadTargets: new Map(), liveTurnByThread: new Map([["t1", "turn-1"]]), turnUsage: new Map(), turnContext: new Map(),
      cancelDirectTurnDispatch() {}, revokeInternalCapabilitiesForThread() {}, repeats: { settle() {} },
      botForThread: () => ({ id: "eli" }), activeRoutineRunForThread: () => undefined,
      runningTurnInstance: () => ({ adapter: { interruptTurn: async () => {} } }),
      failedTurnTool: (name: string) => ({ name, ok: false }), reportIncident() {},
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
    context.watchdog.options.onStall({ threadId: "t1", botId: "eli" }, { kind: "silence", ms: 20 * 60_000 });
    const told = 'No activity for 20 minutes — the turn was stopped. Before it stopped it made 1 tool call: Bash ×1.\nIts last message, quoted: "Exporting the second half now."';
    expect(settled).toEqual([{ generation: "gen-1", text: told }]);
    expect(delegations).toEqual([]);
  });

  it("says when a tool ran past its own deadline", () => {
    const { context, settled } = load();
    context.watchdog.options.onStall({ threadId: "t1", botId: "eli" }, { kind: "tool", ms: 120 * 60_000 });
    expect(settled[0]!.text).toMatch(/^A tool ran for 120 minutes without finishing — the turn was stopped\. Before it stopped/);
  });

  it("says when a tool ran past the cap that counts its waits", () => {
    const { context, settled } = load();
    context.watchdog.options.onStall({ threadId: "t1", botId: "eli" }, { kind: "tool-cap", ms: 240 * 60_000 });
    expect(settled[0]!.text).toMatch(/^A tool ran too long: 240 minutes since it started, waits included — the turn was stopped\. Before it stopped/);
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
    context.watchdog.options.onStall({ threadId: "t1", botId: "eli" }, { kind: "silence", ms: 20 * 60_000 });
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
    expect(r.limits).toEqual([{ kind: "silence", ms: STALL }]);
    // The stall handler cancels the dispatch after the sweep dropped the turn: that must not watch it again.
    r.dog.eventsDiscarded("t1");
    expect(r.dog.watching("t1")).toBe(false);
  });
});
