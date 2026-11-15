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

describe("the scheduler and a run that is being made ready", () => {
  function harness() {
    const dir = mkdtempSync(join(tmpdir(), "omb-run-gate-"));
    dirs.push(dir);
    const started: string[] = [];
    const release = new Map<string, (reason: string | null) => void>();
    let tasks = 0;
    const manager = new RoutineManager({
      file: join(dir, "routines.json"), botState: () => "ready",
      createTask: (botId) => ({ threadId: `${botId}-thread-${++tasks}` }),
      startTurn: async (botId) => { started.push(botId); },
      prepareRun: (run) => run.botId === "cloud-bot" ? new Promise((resolve) => release.set(run.id, resolve)) : null,
      preparing: "Waiting for its cloud computer",
    });
    const routine = (botId: string) => manager.create({ name: `${botId} sweep`, prompt: "Sweep", botId, schedule: { type: "daily", time: "09:00", weekdays: [3] } });
    return { manager, started, release, routine };
  }

  it("does not hold up other bots' runs, shows why the held one waits, and starts it once ready", async () => {
    const h = harness();
    const held = h.manager.runNow(h.routine("cloud-bot").id)!;
    h.manager.runNow(h.routine("other-bot").id);
    await h.manager.tick();
    expect(h.started).toEqual(["other-bot"]);
    expect(h.manager.listRuns().find((run) => run.id === held.id)).toMatchObject({ status: "queued", attention: "Waiting for its cloud computer" });
    h.release.get(held.id)!(null);
    await settle();
    await h.manager.tick();
    expect(h.started).toEqual(["other-bot", "cloud-bot"]);
    expect(h.manager.listRuns().find((run) => run.id === held.id)!.status).toBe("running");
  });

  it("fails the run with the reason, before any turn starts, and leaves the routine on", async () => {
    const h = harness();
    const routine = h.routine("cloud-bot");
    const held = h.manager.runNow(routine.id)!;
    await h.manager.tick();
    h.release.get(held.id)!("The cloud computer did not answer after a restart, so this run did not start.");
    await settle();
    await h.manager.tick();
    expect(h.started).toEqual([]);
    expect(h.manager.listRuns().find((run) => run.id === held.id)).toMatchObject({ status: "failed", error: "The cloud computer did not answer after a restart, so this run did not start." });
    expect(h.manager.listRoutines().find((candidate) => candidate.id === routine.id)).toMatchObject({ enabled: true });
  });
});
