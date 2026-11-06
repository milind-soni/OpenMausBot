import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeEvent } from "./contracts.ts";
import { RoutineManager, type RoutineManagerOptions, type RoutineRun } from "./routines.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const START = Date.parse("2026-11-05T08:00:00Z");

function harness(file = join(mkdtempSync(join(tmpdir(), "omb-steps-")), "routines.json"), model?: string) {
  dirs.push(join(file, ".."));
  let now = START, task = 0;
  const tasks: Array<{ botId: string; threadId: string }> = [];
  const started: Array<{ botId: string; threadId: string; prompt: string }> = [];
  const interrupted: Array<{ botId: string; threadId: string }> = [];
  const options: RoutineManagerOptions = {
    file, now: () => now, botState: () => "ready",
    createTask: (botId) => {
      const threadId = `thread-${++task}`;
      tasks.push({ botId, threadId });
      return { threadId, ...(model ? { model } : {}) };
    },
    startTurn: async (botId, threadId, prompt) => { started.push({ botId, threadId, prompt }); },
    interruptTurn: async (botId, threadId) => { interrupted.push({ botId, threadId }); },
    stepBotProblem: (_owner, botId) => botId === "hidden" ? "That bot is not one you can hand work to" : null,
    botName: (botId) => ({ researcher: "Research", chief: "Chief" })[botId],
  };
  const manager = new RoutineManager(options);
  const event = (threadId: string, patch: Partial<RuntimeEvent>) => manager.handleRuntimeEvent({
    eventId: `e-${Math.random()}`, provider: "fake", threadId, createdAt: new Date(now).toISOString(), ...patch,
  } as RuntimeEvent);
  const reply = (threadId: string, text: string, cost?: number) => {
    event(threadId, { type: "item.completed", itemType: "assistant_text", itemId: "reply", text } as Partial<RuntimeEvent>);
    return event(threadId, { type: "turn.completed", ok: true, ...(cost === undefined ? {} : { cost }) } as Partial<RuntimeEvent>);
  };
  const settle = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await manager.tick(); };
  return { manager, file, tasks, started, interrupted, event, reply, settle, setNow: (at: number) => (now = at) };
}

const steps = [
  { botId: "researcher", instructions: "Find three AI news items." },
  { botId: "chief", instructions: "Write a five-line summary.", model: "quick" as const },
  { botId: "chief", instructions: "Does the summary mention a release?", check: true as const },
];
const routineInput = (plan = steps) => ({
  name: "Morning news", prompt: "Tell me about AI releases each morning.", botId: "chief", enabled: false,
  schedule: { type: "interval" as const, everyMinutes: 60, anchorAt: START + 3_600_000 }, steps: plan,
});
const runOf = (h: ReturnType<typeof harness>, id: string) => h.manager.listRuns().find((run) => run.id === id)!;
async function startRun(h: ReturnType<typeof harness>, plan = steps): Promise<RoutineRun> {
  const routine = h.manager.create(routineInput(plan));
  const run = h.manager.runNow(routine.id)!;
  await h.settle();
  return runOf(h, run.id);
}

describe("a routine that splits its work into steps", () => {
  it("walks each step on its own bot in a fresh thread, handing on only the previous reply, and reports the last real reply", async () => {
    const h = harness(undefined, "Haiku 5.5");
    const run = await startRun(h);
    expect(h.tasks).toEqual([{ botId: "researcher", threadId: "thread-1" }]);
    expect(h.started[0]).toMatchObject({ botId: "researcher", threadId: "thread-1" });
    expect(h.started[0]!.prompt).toContain('Step 1 of 3 of the routine "Morning news"');
    expect(h.started[0]!.prompt).not.toContain("<previous-step");

    h.reply("thread-1", "1. Model X shipped\n2. Lab Y raised\n3. Tool Z launched", 0.5);
    await h.settle();
    expect(h.tasks[1]).toEqual({ botId: "chief", threadId: "thread-2" });
    const second = h.started[1]!;
    expect(second).toMatchObject({ botId: "chief", threadId: "thread-2" });
    expect(second.prompt).toContain('<previous-step from="Research">\n1. Model X shipped\n2. Lab Y raised\n3. Tool Z launched\n</previous-step>');
    expect(second.prompt).toContain("Your part: Write a five-line summary.");
    expect(second.prompt).not.toContain("Find three AI news items.");
    expect(runOf(h, run.id)).toMatchObject({ status: "running", stepAt: 1, threadId: "thread-2" });

    h.reply("thread-2", "Model X shipped a release today.");
    await h.settle();
    expect(h.started[2]).toMatchObject({ botId: "chief", threadId: "thread-3" });
    expect(h.started[2]!.prompt).toContain("Answer the question with YES or NO alone on the last line.");
    expect(h.started[2]!.prompt).toContain("Model X shipped a release today.");

    h.reply("thread-3", "It does.\nYES.");
    await h.settle();
    const done = runOf(h, run.id);
    expect(done).toMatchObject({ status: "completed", threadId: "thread-2", output: "Model X shipped a release today.", cost: 0.5 });
    expect(done.handoff).toBeUndefined();
    expect(done.report).toBeUndefined();
    expect(done.stepRuns!.map((step) => [step.status, step.threadId, step.answer])).toEqual([
      ["done", "thread-1", undefined], ["done", "thread-2", undefined], ["done", "thread-3", "yes"],
    ]);
    expect(done.stepRuns![0]).toMatchObject({ model: "Haiku 5.5", cost: 0.5 });
    expect(h.manager.runForThread("thread-1")?.id).toBe(run.id);
    expect(h.started).toHaveLength(3);
  });

  it("ends quietly when a check answers no, skipping every later step", async () => {
    const h = harness();
    const plan = [steps[0]!, { ...steps[2]!, instructions: "Is any item about a release?" }, steps[1]!];
    const run = await startRun(h, plan);
    h.reply("thread-1", "Nothing shipped.");
    await h.settle();
    h.reply("thread-2", "no");
    await h.settle();
    const done = runOf(h, run.id);
    expect(done).toMatchObject({ status: "completed", report: { state: "quiet" }, threadId: "thread-1", output: "Nothing shipped." });
    expect(done.stepRuns!.map((step) => step.status)).toEqual(["done", "done", "skipped"]);
    expect(done.stepRuns![1]!.answer).toBe("no");
    expect(h.started).toHaveLength(2);
  });

  it("fails the run when a check answers neither yes nor no", async () => {
    const h = harness();
    const run = await startRun(h);
    h.reply("thread-1", "News.");
    await h.settle();
    h.reply("thread-2", "Summary.");
    await h.settle();
    h.reply("thread-3", "Probably.");
    await h.settle();
    expect(runOf(h, run.id)).toMatchObject({ status: "failed", error: "Step 3 didn't answer yes or no" });
    expect(runOf(h, run.id).stepRuns!.map((step) => step.status)).toEqual(["done", "done", "failed"]);
  });

  it("hands on nothing from a step that ended without a reply, never the step before it", async () => {
    const h = harness();
    await startRun(h);
    h.reply("thread-1", "Model X shipped.");
    await h.settle();
    h.event("thread-2", { type: "turn.completed", ok: true } as Partial<RuntimeEvent>);
    await h.settle();
    expect(h.started[2]!.prompt).not.toContain("Model X shipped.");
  });

  it("retries a failed step once in its own thread, then fails the run with the rest skipped", async () => {
    const h = harness();
    const run = await startRun(h);
    h.reply("thread-1", "News.");
    await h.settle();
    const crash = () => {
      h.event("thread-2", { type: "runtime.error", message: "the engine exited" } as Partial<RuntimeEvent>);
      h.event("thread-2", { type: "turn.completed", ok: false } as Partial<RuntimeEvent>);
    };
    crash();
    expect(runOf(h, run.id)).toMatchObject({ status: "queued", retried: "failed", stepAt: 1, threadId: "thread-2" });
    h.setNow(START + 60_000);
    await h.settle();
    expect(h.started[2]).toMatchObject({ botId: "chief", threadId: "thread-2" });
    expect(h.started[2]!.prompt).toContain("News.");
    expect(h.tasks).toHaveLength(2);
    crash();
    await h.settle();
    const failed = runOf(h, run.id);
    expect(failed.status).toBe("failed");
    expect(failed.stepRuns!.map((step) => step.status)).toEqual(["done", "failed", "skipped"]);
  });

  it("reruns the running step after a restart, still holding the previous step's reply", async () => {
    const h = harness();
    const run = await startRun(h);
    h.reply("thread-1", "Saved news.");
    await h.settle();
    h.manager.close();
    const again = harness(h.file);
    expect(runOf(again, run.id)).toMatchObject({ status: "queued", retried: "restarted", stepAt: 1, threadId: "thread-2", handoff: "Saved news." });
    again.setNow(START + 60_000);
    await again.manager.tick();
    expect(again.started[0]).toMatchObject({ botId: "chief", threadId: "thread-2" });
    expect(again.started[0]!.prompt).toContain("Saved news.");
  });

  it("interrupts the running step's bot when the run is cancelled", async () => {
    const h = harness();
    const run = await startRun(h);
    h.reply("thread-1", "News.");
    await h.settle();
    await h.manager.cancelRun(run.id);
    expect(h.interrupted).toEqual([{ botId: "chief", threadId: "thread-2" }]);
    expect(runOf(h, run.id).stepRuns!.map((step) => step.status)).toEqual(["done", "skipped", "skipped"]);
  });

  it("refuses steps out of range, a first-step check, a bot it cannot hand work to, and steps with checks or the routine's own model", () => {
    const h = harness();
    const one = [steps[0]!];
    const seven = Array.from({ length: 7 }, () => steps[0]!);
    expect(() => h.manager.create(routineInput(one))).toThrow("2 to 6");
    expect(() => h.manager.create(routineInput(seven))).toThrow("2 to 6");
    expect(() => h.manager.create(routineInput([steps[2]!, steps[0]!]))).toThrow("The first step can't be a check");
    expect(() => h.manager.create(routineInput([steps[0]!, { botId: "hidden", instructions: "Help." }]))).toThrow("not one you can hand work to");
    expect(() => h.manager.create({ ...routineInput(), checks: ["mail"] })).toThrow("Steps work only on a bot routine");
    expect(() => h.manager.create({ ...routineInput(), modelSelection: { instanceId: "claude", model: "claude-haiku-5-5" } })).toThrow("Steps work only on a bot routine");
  });

  it("keeps steps through an update that leaves them out, and removes them with null", () => {
    const h = harness();
    const routine = h.manager.create(routineInput());
    expect(h.manager.update(routine.id, { name: "Renamed" })!.steps).toEqual(steps);
    expect(h.manager.update(routine.id, { steps: null })!.steps).toBeUndefined();
  });
});
