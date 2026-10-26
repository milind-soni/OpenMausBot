import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CHECK_BOOT_HOLD_MS, CHECK_RUNS_PER_DAY } from "./routine-check-pacing.ts";
import { CHECK_WAKE_MS } from "./routine-due.ts";
import { RoutineManager, type RoutineCheckResult, type RoutineChecks, type RoutineInput, type RoutineRun } from "./routines.ts";

const MINUTE = 60_000;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function harness(options: { bot?: () => "ready" | "busy" | "missing" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-checks-"));
  dirs.push(dir);
  let now = new Date(2026, 9, 22, 9, 0, 0).getTime();
  const answers: RoutineCheckResult[] = [];
  const asked: Array<{ name: string; manual: boolean; hold?: string }> = [];
  const settled: RoutineRun[] = [];
  const released: string[] = [];
  const started: Array<{ threadId: string; prompt: string }> = [];
  const failed: Array<{ run: RoutineRun; alert: unknown }> = [];
  const deferred: RoutineRun[] = [];
  let thread = 0;
  const gate: { wait?: Promise<void> } = {};
  const checks: RoutineChecks = {
    async check(routine, context) {
      asked.push({ name: routine.name, manual: context.manual, ...(context.hold ? { hold: context.hold } : {}) });
      await gate.wait;
      return answers.shift() ?? {};
    },
    release: (key) => released.push(key),
    settled: (run) => settled.push(run),
  };
  const make = () => new RoutineManager({
    file: join(dir, "routines.json"), now: () => now, botState: options.bot ?? (() => "ready"),
    createTask: () => ({ threadId: `thread-${++thread}` }),
    startTurn: async (_botId, threadId, prompt) => { started.push({ threadId, prompt }); },
    onRunFailed: (run, alert) => failed.push({ run, alert }),
    onRunDeferred: (run) => deferred.push(run),
    checks,
  });
  let manager = make();
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
  const tick = async () => { await manager.tick(); await settle(); };
  const watch = (extra: Partial<RoutineInput> = {}) => manager.create({
    name: "Keep an eye on my day", prompt: "Check my day.", botId: "chief",
    schedule: { type: "interval", everyMinutes: 15, anchorAt: now + 15 * MINUTE }, checks: ["calendar", "mail", "runs"], access: "read-and-draft", deliver: "brief", ...extra,
  });
  const complete = (run: RoutineRun, ok = true, error?: string) => {
    if (error) manager.handleRuntimeEvent({ type: "runtime.error", threadId: run.threadId!, message: error } as never);
    manager.handleRuntimeEvent({ type: "turn.completed", threadId: run.threadId!, ok, stopReason: ok ? "end_turn" : "error" } as never);
  };
  return {
    get manager() { return manager; }, gate, answers, asked, settled, released, started, failed, deferred, tick, watch, complete, settle,
    advance: (ms: number) => { now += ms; },
    now: () => now,
    restart: () => { manager = make(); },
    file: join(dir, "routines.json"),
  };
}

const past = (h: ReturnType<typeof harness>, ms: number) => { h.advance(ms); return h.tick(); };

describe("routines with checks", () => {
  it("a check that finds nothing starts no AI turn and leaves no run, only when it last checked", async () => {
    const h = harness();
    const routine = h.watch();
    await past(h, CHECK_BOOT_HOLD_MS + 15 * MINUTE);
    expect(h.asked).toEqual([{ name: "Keep an eye on my day", manual: false }]);
    expect(h.manager.listRuns()).toEqual([]);
    expect(h.started).toEqual([]);
    expect(h.manager.listRoutines()[0]).toMatchObject({ id: routine.id, checkedAt: h.now() });
    expect(h.manager.listRoutines()[0].nextRunAt).toBeGreaterThan(h.now());
  });

  it("items that need the AI become one run with the checks' prompt, kept or released once it ends", async () => {
    const h = harness();
    h.watch();
    h.answers.push({ run: { prompt: "[Records from Gmail]\ntwo new emails", key: "batch-1" } });
    await past(h, CHECK_BOOT_HOLD_MS + 15 * MINUTE);
    const [run] = h.manager.listRuns();
    expect(run).toMatchObject({ status: "running", checkKey: "batch-1", access: "read-and-draft", deliver: "brief", triggerSource: "schedule" });
    expect(h.started).toHaveLength(1);
    expect(h.started[0]!.prompt).toContain("[Records from Gmail]\ntwo new emails");
    expect(h.manager.listRoutines()[0].checkedAt).toBeUndefined();
    h.complete(h.manager.listRuns()[0]!);
    expect(h.settled.map((one) => [one.checkKey, one.status])).toContainEqual(["batch-1", "completed"]);
  });

  it("reports a check whose result cannot be written, releases its items and checks again later", async () => {
    const h = harness();
    h.watch();
    h.answers.push({ run: { prompt: "batch", key: "batch-1" } });
    let open!: () => void;
    h.gate.wait = new Promise((resolve) => { open = resolve; });
    h.advance(CHECK_BOOT_HOLD_MS + 15 * MINUTE);
    await h.tick();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const save = vi.spyOn(h.manager as unknown as { save(): void }, "save").mockImplementation(() => { throw new Error("fixture disk full"); });
    try {
      open();
      await h.settle();
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(/^routines: /), expect.objectContaining({ message: "fixture disk full" }));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      save.mockRestore();
      logged.mockRestore();
    }
    expect(h.released).toEqual(["batch-1"]);
    expect(h.manager.listRuns()).toEqual([]);
    delete h.gate.wait;
    h.answers.push({ run: { prompt: "batch", key: "batch-1" } });
    await past(h, 15 * MINUTE);
    expect(h.manager.listRuns()).toEqual([expect.objectContaining({ status: "running", checkKey: "batch-1" })]);
  });

  it("checks keep running while their run works, but hand the AI nothing until it ends", async () => {
    const h = harness();
    h.watch();
    h.answers.push({ run: { prompt: "batch", key: "batch-1" } });
    await past(h, CHECK_BOOT_HOLD_MS + 15 * MINUTE);
    await past(h, 15 * MINUTE);
    expect(h.asked.at(-1)).toEqual({ name: "Keep an eye on my day", manual: false, hold: "running" });
    expect(h.manager.listRuns()).toHaveLength(1);
  });

  it("waits two minutes after start before the first check", async () => {
    const h = harness();
    h.watch({ schedule: { type: "interval", everyMinutes: 15, anchorAt: h.now() + MINUTE } });
    await past(h, MINUTE);
    expect(h.asked).toEqual([]);
    await past(h, CHECK_BOOT_HOLD_MS - MINUTE);
    expect(h.asked).toHaveLength(1);
  });

  it("after a long sleep the missed checks merge into one, never a missed run", async () => {
    const h = harness();
    h.watch();
    await past(h, 13 * 60 * MINUTE);
    expect(h.asked).toHaveLength(1);
    expect(h.manager.listRuns()).toEqual([]);
    expect(h.failed).toEqual([]);
    await h.tick();
    expect(h.asked).toHaveLength(1);
  });

  it("only the next on-time job keeps the computer awake; a Cloud also wakes hourly, and it runs the checks then", async () => {
    const h = harness();
    h.watch();
    expect(h.manager.wakeHold()).toEqual({ hold: false });
    expect(h.manager.nextDueAt()).toBe(h.now() + CHECK_WAKE_MS);
    const reminder = h.now() + CHECK_BOOT_HOLD_MS + 40 * MINUTE;
    h.answers.push({ wakeAt: reminder });
    await past(h, CHECK_BOOT_HOLD_MS + 15 * MINUTE);
    expect(h.manager.nextDueAt()).toBe(reminder);
    expect(h.manager.wakeHold()).toEqual({ hold: true, reason: "due", at: reminder });
    h.advance(reminder - h.now());
    await h.tick();
    expect(h.asked).toHaveLength(2);
    expect(h.manager.wakeHold()).toEqual({ hold: false });
    expect(h.manager.nextDueAt()).toBe(reminder + CHECK_WAKE_MS);
    h.advance(CHECK_WAKE_MS);
    await h.tick();
    expect(h.asked).toHaveLength(3);
  });

  it("a read that fails is never nothing new: the routine says why and keeps no checked time", async () => {
    const h = harness();
    h.watch();
    h.answers.push({ trouble: "Couldn't read Gmail. Reconnect it in Connected apps." });
    await past(h, CHECK_BOOT_HOLD_MS + 15 * MINUTE);
    expect(h.manager.listRoutines()[0]).toMatchObject({ checkTrouble: "Couldn't read Gmail. Reconnect it in Connected apps." });
    expect(h.manager.listRoutines()[0].checkedAt).toBeUndefined();
    await past(h, 15 * MINUTE);
    expect(h.manager.listRoutines()[0].checkTrouble).toBeUndefined();
    expect(h.manager.listRoutines()[0].checkedAt).toBe(h.now());
  });

  it("starts at most the day's runs, then holds the rest", async () => {
    const h = harness();
    h.watch({ schedule: { type: "interval", everyMinutes: 5, anchorAt: h.now() + 5 * MINUTE } });
    h.advance(CHECK_BOOT_HOLD_MS);
    for (let index = 0; index < CHECK_RUNS_PER_DAY; index++) {
      h.answers.push({ run: { prompt: `batch ${index}`, key: `batch-${index}` } });
      await past(h, 5 * MINUTE);
      h.complete(h.manager.listRuns()[0]!);
    }
    await past(h, 5 * MINUTE);
    expect(h.asked.at(-1)?.hold).toBe("capped");
    expect(h.manager.listRuns()).toHaveLength(CHECK_RUNS_PER_DAY);
  });

  it("after a failed run it backs off, longer each time, and tells the owner once per streak", async () => {
    const h = harness();
    h.watch({ schedule: { type: "interval", everyMinutes: 5, anchorAt: h.now() + CHECK_BOOT_HOLD_MS + 5 * MINUTE } });
    h.answers.push({ run: { prompt: "batch", key: "batch-1" } });
    await past(h, CHECK_BOOT_HOLD_MS + 5 * MINUTE);
    h.complete(h.manager.listRuns()[0]!, false, "The model refused the request");
    expect(h.failed).toHaveLength(1);
    expect(h.failed[0]!.alert).toBeUndefined();
    await past(h, 5 * MINUTE);
    expect(h.asked.at(-1)?.hold).toBe("backoff");
    for (let index = 0; index < 3; index++) await past(h, 5 * MINUTE);
    h.answers.push({ run: { prompt: "batch", key: "batch-2" } });
    await past(h, 5 * MINUTE);
    const second = h.manager.listRuns().find((run) => run.checkKey === "batch-2")!;
    expect(second).toBeDefined();
    h.complete(second, false, "Another refusal");
    expect(h.failed).toHaveLength(2);
    expect(h.failed[1]!.alert).toBeNull();
    for (let index = 0; index < 4; index++) await past(h, 5 * MINUTE);
    expect(h.asked.at(-1)?.hold).toBe("backoff");
    for (let index = 0; index < 4; index++) await past(h, 5 * MINUTE);
    expect(h.asked.at(-1)?.hold).toBeUndefined();
  });

  it("a checked run waits for a busy bot without a notice, and never fails for being busy", async () => {
    let state: "ready" | "busy" = "busy";
    const h = harness({ bot: () => state });
    h.watch();
    h.answers.push({ run: { prompt: "batch", key: "batch-1" } });
    await past(h, CHECK_BOOT_HOLD_MS + 15 * MINUTE);
    for (let index = 0; index < 8; index++) await past(h, 15 * MINUTE);
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "queued", checkKey: "batch-1" });
    expect(h.deferred).toEqual([]);
    expect(h.failed).toEqual([]);
    state = "ready";
    await h.tick();
    expect(h.manager.listRuns()[0].status).toBe("running");
  });

  it("Run now checks first: nothing new completes quietly, found items fill the run", async () => {
    const h = harness();
    const routine = h.watch();
    h.advance(CHECK_BOOT_HOLD_MS);
    const quiet = h.manager.runNow(routine.id)!;
    await h.settle();
    expect(h.asked).toEqual([{ name: "Keep an eye on my day", manual: true }]);
    expect(h.manager.listRuns().find((run) => run.id === quiet.id)).toMatchObject({ status: "completed", report: { state: "quiet" } });
    expect(h.started).toEqual([]);
    h.answers.push({ run: { prompt: "batch", key: "batch-1" } });
    const found = h.manager.runNow(routine.id)!;
    await h.settle();
    await h.tick();
    expect(h.manager.listRuns().find((run) => run.id === found.id)).toMatchObject({ status: "running", checkKey: "batch-1", manual: true });
    expect(h.started).toHaveLength(1);
  });

  it("pausing the routine stops its checks, and a run found as it paused is released", async () => {
    const h = harness();
    const routine = h.watch();
    h.manager.update(routine.id, { enabled: false });
    await past(h, CHECK_BOOT_HOLD_MS + 60 * MINUTE);
    expect(h.asked).toEqual([]);
    h.manager.update(routine.id, { enabled: true });
    let answer!: () => void;
    h.gate.wait = new Promise<void>((resolve) => { answer = resolve; });
    h.answers.push({ run: { prompt: "batch", key: "batch-1" } });
    await past(h, 15 * MINUTE);
    expect(h.asked).toHaveLength(1);
    h.manager.update(routine.id, { enabled: false });
    answer();
    await h.settle();
    expect(h.manager.listRuns()).toEqual([]);
    expect(h.released).toEqual(["batch-1"]);
  });

  it("keeps checks, access and delivery across restarts, and an edit can remove them", async () => {
    const h = harness();
    const routine = h.watch();
    h.restart();
    expect(h.manager.listRoutines()[0]).toMatchObject({ checks: ["calendar", "mail", "runs"], access: "read-and-draft", deliver: "brief" });
    const saved = JSON.parse(readFileSync(h.file, "utf8")).routines[0];
    expect(saved).toMatchObject({ checks: ["calendar", "mail", "runs"], access: "read-and-draft", deliver: "brief" });
    const plain = h.manager.update(routine.id, { checks: null, access: null, deliver: null })!;
    expect(plain.checks).toBeUndefined();
    expect(plain.access).toBeUndefined();
    expect(plain.deliver).toBeUndefined();
  });

  it("refuses checks it does not know, and checks on a routine that runs once", () => {
    const h = harness();
    expect(() => h.watch({ checks: ["mail", "weather" as never] })).toThrow("Choose checks from calendar, mail and runs");
    expect(() => h.watch({ schedule: { type: "once", at: h.now() + MINUTE } })).toThrow("Checks need a bot routine that repeats");
    expect(() => h.watch({ access: "everything" as never })).toThrow("Choose read-and-draft access or none");
  });
});
