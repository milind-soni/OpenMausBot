// Stall-watchdog contract: activity keeps a turn alive indefinitely, human
// approvals pause the clock, silence past the ceiling stalls exactly once.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import type { Message } from "./store.ts";
import { TurnStops, stoppedTurnOutcome } from "./turn-outcome.ts";
import { TurnWatchdog, type WatchedTurn } from "./turn-watchdog.ts";

const STALL = 10_000;

function rig() {
  let now = 0;
  const stalls: WatchedTurn[] = [];
  const dog = new TurnWatchdog({
    stallMs: STALL,
    checkMs: 60_000,
    onStall: (turn) => stalls.push(turn),
    now: () => now,
  });
  return { dog, stalls, tick: (ms: number) => (now += ms) };
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
      dog.touch("t1");
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
    // the answer restarts the clock rather than inheriting the wait
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

  it("lets the computer wait's own deadline govern, then restarts the stall clock", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    dog.setWaitingOnComputer("t1", true);
    tick(STALL * 100);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    // Resolving an unrelated human ask cannot clear the resource wait.
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
});

// The harness's stall handler (index.ts), run without starting a server: the
// requester of a stalled teammate hears the stall and what the turn did, never
// a bare "The coordinated turn was interrupted".
describe("the stall handler", () => {
  function load() {
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
      process: { env: {} },
      RoomTurnStallRegistry: class { stall() {} },
      TurnStops, stoppedTurnOutcome, reportsToRequester: () => true,
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
    });
    vm.runInContext(code, context, { filename: "index.ts (stall handler fixture)" });
    return { context, settled, delegations };
  }

  it("tells a stalled turn's requester why it stopped and what it did", () => {
    const { context, settled, delegations } = load();
    context.watchdog.options.onStall({ threadId: "t1", botId: "eli" });
    const told = 'No activity for 20 minutes — the turn was stopped. Before it stopped it made 1 tool call: Bash ×1.\nIts last message, quoted: "Exporting the second half now."';
    expect(settled).toEqual([{ generation: "gen-1", text: told }]);
    expect(delegations).toEqual([`Delegated turn did not finish — ${told}`]);
  });

  // A harness stop that leaves its engine attached (a Company change) notes
  // its cause first: the turn's own end, settling the requester before the
  // harness's teardown does, reports that cause instead of "interrupted".
  it("gives a stopped turn's own end the cause the harness noted before interrupting it", () => {
    const { context } = load();
    expect(context.stoppedTurnText("t1", "turn-1", undefined, "interrupted")).toMatch(/^The turn did not complete \(interrupted\)\. /);
    vm.runInContext('turnStops.stopping("t1", "turn-1", "turn interrupted — the Company connection changed")', context);
    expect(context.stoppedTurnText("t1", "turn-1", undefined, "interrupted")).toMatch(/^Turn interrupted — the Company connection changed\. Before it stopped/);
  });
});
