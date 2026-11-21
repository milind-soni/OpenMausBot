import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createRunGate } from "./routine-run-gate.ts";
import { RoutineManager } from "./routines.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("holding a run while something it needs is made ready", () => {
  it("starts a run nothing is prepared for, holds one being prepared, and reads each result once", async () => {
    let finish!: (reason: string | null) => void;
    let settled = 0;
    const gate = createRunGate<{ id: string; slow?: true }>((run) => run.slow ? new Promise((resolve) => { finish = resolve; }) : null, () => { settled++; });
    expect(gate.hold({ id: "quick" })).toBe(false);
    expect(gate.hold({ id: "slow", slow: true })).toBe(true);
    expect(gate.hold({ id: "slow", slow: true })).toBe(true);
    expect(gate.waiting("slow")).toBe(true);
    finish("its computer did not answer");
    await settle();
    expect(settled).toBe(1);
    expect(gate.hold({ id: "slow", slow: true })).toBe("its computer did not answer");
    expect(gate.waiting("slow")).toBe(false);
  });

  it("starts the run when the preparation itself breaks: the run reports its own trouble", async () => {
    const gate = createRunGate<{ id: string }>(() => Promise.reject(new Error("lookup failed")), () => {});
    expect(gate.hold({ id: "a" })).toBe(true);
    await settle();
    expect(gate.hold({ id: "a" })).toBe(false);
  });
});

describe("stopping the work for a run that no longer waits", () => {
  it("aborts it and forgets its result, and leaves a run that still waits alone", async () => {
    const signals = new Map<string, AbortSignal>();
    const finish = new Map<string, (reason: string | null) => void>();
    let settled = 0;
    const gate = createRunGate<{ id: string }>((run, signal) => { signals.set(run.id, signal); return new Promise((resolve) => finish.set(run.id, resolve)); }, () => { settled++; });
    gate.hold({ id: "cancelled" });
    gate.hold({ id: "waiting" });
    gate.sweep((id) => id === "waiting");
    expect(signals.get("cancelled")!.aborted).toBe(true);
    expect(signals.get("waiting")!.aborted).toBe(false);
    expect(gate.waiting("cancelled")).toBe(false);
    finish.get("cancelled")!("its computer did not answer");
    await settle();
    expect(settled).toBe(0);
    // Asked again under the same id it is prepared afresh, never answered with the stale reason.
    expect(gate.hold({ id: "cancelled" })).toBe(true);
  });
});

describe("the scheduler and a run that is being made ready", () => {
  const START = new Date(2026, 10, 14, 8, 0, 0).getTime();
  function harness() {
    const dir = mkdtempSync(join(tmpdir(), "omb-run-gate-"));
    dirs.push(dir);
    let at = START;
    const started: string[] = [];
    const prepared: Array<{ runId: string; signal: AbortSignal }> = [];
    const release = new Map<string, (reason: string | null) => void>();
    let tasks = 0;
    const manager = new RoutineManager({
      file: join(dir, "routines.json"), now: () => at, botState: () => "ready",
      createTask: (botId) => ({ threadId: `${botId}-thread-${++tasks}` }),
      startTurn: async (botId) => { started.push(botId); },
      prepareRun: (run, signal) => {
        if (run.botId !== "cloud-bot") return null;
        prepared.push({ runId: run.id, signal });
        return new Promise((resolve) => release.set(run.id, resolve));
      },
      preparing: "Waiting for its cloud computer",
    });
    const routine = (botId: string) => manager.create({ name: `${botId} sweep`, prompt: "Sweep", botId, schedule: { type: "interval", everyMinutes: 60, anchorAt: START } });
    /** The routines' next scheduled occurrence comes due; answers the runs it made. */
    const due = async () => {
      const before = new Set(manager.listRuns().map((run) => run.id));
      at = Math.max(...manager.listRoutines().map((entry) => entry.nextRunAt ?? at));
      await manager.tick();
      return manager.listRuns().filter((run) => !before.has(run.id));
    };
    return { manager, started, prepared, release, routine, due };
  }
  const runOf = (h: ReturnType<typeof harness>, id: string) => h.manager.listRuns().find((run) => run.id === id)!;

  it("does not hold up other bots' runs, shows why the held one waits, and starts it once ready", async () => {
    const h = harness();
    h.routine("cloud-bot");
    h.routine("other-bot");
    const held = (await h.due()).find((run) => run.botId === "cloud-bot")!;
    expect(h.started).toEqual(["other-bot"]);
    expect(runOf(h, held.id)).toMatchObject({ status: "queued", attention: "Waiting for its cloud computer" });
    h.release.get(held.id)!(null);
    await settle();
    await h.manager.tick();
    expect(h.started).toEqual(["other-bot", "cloud-bot"]);
    expect(runOf(h, held.id).status).toBe("running");
  });

  it("fails the run with the reason, before any turn starts, and leaves the routine on", async () => {
    const h = harness();
    const routine = h.routine("cloud-bot");
    const [held] = await h.due();
    h.release.get(held!.id)!("The cloud computer did not answer after a restart, so this run did not start.");
    await settle();
    await h.manager.tick();
    expect(h.started).toEqual([]);
    expect(runOf(h, held!.id)).toMatchObject({ status: "failed", error: "The cloud computer did not answer after a restart, so this run did not start." });
    expect(h.manager.listRoutines().find((candidate) => candidate.id === routine.id)).toMatchObject({ enabled: true });
  });

  it("never holds a run a person started by hand: its conversation opens at once", async () => {
    const h = harness();
    const run = h.manager.runNow(h.routine("cloud-bot").id)!;
    await h.manager.tick();
    expect(h.prepared).toEqual([]);
    expect(h.started).toEqual(["cloud-bot"]);
    expect(runOf(h, run.id)).toMatchObject({ status: "running", threadId: expect.any(String) });
  });

  it("stops the work for a held run that is cancelled, and never starts it", async () => {
    const h = harness();
    h.routine("cloud-bot");
    const [held] = await h.due();
    expect(h.prepared[0]!.signal.aborted).toBe(false);
    await h.manager.cancelRun(held!.id);
    await settle();
    await h.manager.tick();
    expect(h.prepared[0]!.signal.aborted).toBe(true);
    h.release.get(held!.id)!(null);
    await settle();
    await h.manager.tick();
    expect(h.started).toEqual([]);
    expect(runOf(h, held!.id).status).toBe("cancelled");
  });
});
