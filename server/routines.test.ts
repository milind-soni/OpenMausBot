import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GroupGoalRunStatus } from "../shared/group-goal-run.ts";
import {
  nextOccurrence,
  RoutineManager,
  type RoutineManagerOptions,
  type RoutineRun,
  type RoutineSchedule,
} from "./routines.ts";

const dirs: string[] = [];

function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), "omb-routines-"));
  dirs.push(dir);
  return join(dir, "routines.json");
}

function harness(start = new Date(2026, 7, 17, 8, 0, 0).getTime()) {
  let now = start;
  let bot: "ready" | "busy" | "missing" = "ready";
  let goal: "ready" | "busy" | "missing" = "ready";
  let task = 0;
  let goalTask = 0;
  const started: Array<{ botId: string; threadId: string; prompt: string }> = [];
  const startedGoals: Array<{
    groupId: string;
    threadId: string;
    prompt: string;
    coordinatorBotId: string;
    runId: string;
    onDispatchError: (message: string) => void;
  }> = [];
  const runOns: string[] = [];
  const triggerSources: string[] = [];
  const taskActivations: boolean[] = [];
  const goalTasks: Array<{ groupId: string; title: string }> = [];
  const interruptedTurns: Array<{ botId: string; threadId: string; runOn: string }> = [];
  const interruptedGoals: Array<{
    groupId: string;
    threadId: string;
    outcome?: { status: "stopped" | "limit-reached"; detail: string };
  }> = [];
  const emitted: any[] = [];
  const changed: any[] = [];
  const failed: any[] = [];
  const options: RoutineManagerOptions = {
    file: tempFile(),
    now: () => now,
    emit: (payload) => emitted.push(payload),
    botState: () => bot,
    goalState: () => goal,
    createTask: (_botId, _title, activate = false) => {
      taskActivations.push(activate);
      return { threadId: `thread-${++task}` };
    },
    createGoalTask: (groupId, title) => {
      goalTasks.push({ groupId, title });
      return { threadId: `goal-thread-${++goalTask}` };
    },
    startTurn: async (botId, threadId, prompt, runOn, triggerSource) => {
      started.push({ botId, threadId, prompt });
      runOns.push(runOn);
      triggerSources.push(triggerSource);
    },
    startGoal: async (groupId, threadId, prompt, coordinatorBotId, runId, onDispatchError) => {
      startedGoals.push({ groupId, threadId, prompt, coordinatorBotId, runId, onDispatchError });
    },
    interruptTurn: async (botId, threadId, runOn) => {
      interruptedTurns.push({ botId, threadId, runOn });
    },
    interruptGoal: async (groupId, threadId, outcome) => {
      interruptedGoals.push({ groupId, threadId, ...(outcome ? { outcome } : {}) });
    },
    onRunChanged: (run) => changed.push(run),
    onRunFailed: (run) => failed.push(run),
  };
  const manager = new RoutineManager(options);
  return {
    manager,
    options,
    emitted,
    started,
    startedGoals,
    runOns,
    triggerSources,
    taskActivations,
    goalTasks,
    interruptedTurns,
    interruptedGoals,
    changed,
    failed,
    setNow: (value: number) => (now = value),
    setBot: (value: typeof bot) => (bot = value),
    setGoal: (value: typeof goal) => (goal = value),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("nextOccurrence", () => {
  it("finds the next selected weekday in local wall-clock time", () => {
    const monday = new Date(2026, 7, 17, 10, 0, 0).getTime();
    const next = nextOccurrence({ type: "daily", time: "09:30", weekdays: [1, 3] }, monday)!;
    const d = new Date(next);
    expect(d.getDay()).toBe(3);
    expect([d.getHours(), d.getMinutes()]).toEqual([9, 30]);
  });

  it("returns a one-off only while it is still in the future", () => {
    expect(nextOccurrence({ type: "once", at: 200 }, 100)).toBe(200);
    expect(nextOccurrence({ type: "once", at: 100 }, 100)).toBeNull();
  });

  it("keeps interval schedules aligned to their anchor", () => {
    const anchorAt = Date.parse("2026-08-17T08:05:00Z");
    const schedule: RoutineSchedule = { type: "interval", everyMinutes: 5, anchorAt };

    expect(nextOccurrence(schedule, anchorAt - 1)).toBe(anchorAt);
    expect(nextOccurrence(schedule, anchorAt)).toBe(anchorAt + 5 * 60_000);
    expect(nextOccurrence(schedule, anchorAt + 12 * 60_000)).toBe(anchorAt + 15 * 60_000);
    expect(nextOccurrence({
      type: "interval",
      everyMinutes: 5,
      anchorAt: 8_640_000_000_000_000,
    }, 8_640_000_000_000_000)).toBeNull();
  });

  it("keeps restricted intervals on their global cadence inside local days and hours", () => {
    const mondayAtEight = new Date(2026, 7, 17, 8, 0, 0).getTime();
    const schedule: RoutineSchedule = {
      type: "interval",
      everyMinutes: 30,
      anchorAt: mondayAtEight,
      weekdays: [1, 3],
      window: { start: "09:00", end: "10:30" },
    };

    expect(nextOccurrence(schedule, mondayAtEight)).toBe(new Date(2026, 7, 17, 9, 0, 0).getTime());
    expect(nextOccurrence(schedule, new Date(2026, 7, 17, 10, 0, 0).getTime()))
      .toBe(new Date(2026, 7, 19, 9, 0, 0).getTime());
  });

  it("treats an interval end as an inclusive cutoff", () => {
    const anchorAt = new Date(2026, 7, 17, 8, 0, 0).getTime();
    const endsAt = anchorAt + 10 * 60_000;
    const schedule: RoutineSchedule = { type: "interval", everyMinutes: 5, anchorAt, endsAt };

    expect(nextOccurrence(schedule, anchorAt + 5 * 60_000)).toBe(endsAt);
    expect(nextOccurrence(schedule, endsAt)).toBeNull();
  });
});

describe("RoutineManager", () => {
  it("accepts five-minute windows and preserves the manager's clamping semantics", () => {
    const h = harness();
    const create = (name: string, durationMinutes?: number) => h.manager.create({
      name,
      prompt: "Check the queue",
      botId: "maus-1",
      schedule: { type: "daily", time: "09:00", weekdays: [1] },
      durationMinutes,
    });

    expect(create("Minimum", 5).durationMinutes).toBe(5);
    expect(create("Below minimum", 4).durationMinutes).toBe(5);
    expect(create("Default").durationMinutes).toBe(30);
    expect(create("Above maximum", 241).durationMinutes).toBe(240);
  });

  it("validates, preserves, and clears the optional safety timeout", () => {
    const h = harness();
    const input = {
      name: "Bounded routine",
      prompt: "Check the queue",
      botId: "maus-1",
      schedule: { type: "daily" as const, time: "09:00", weekdays: [1] },
    };
    const routine = h.manager.create({ ...input, timeoutMinutes: 5 });
    expect(routine.timeoutMinutes).toBe(5);
    expect(h.manager.update(routine.id, { timeoutMinutes: null })).not.toHaveProperty("timeoutMinutes");
    expect(h.manager.create({ ...input, name: "Unlimited" })).not.toHaveProperty("timeoutMinutes");
    expect(() => h.manager.create({ ...input, timeoutMinutes: 4 })).toThrow(/5 to 240/);
    expect(() => h.manager.create({ ...input, timeoutMinutes: 241 })).toThrow(/5 to 240/);
  });

  it("validates interval cadence and preserves its explicit anchor", () => {
    const h = harness();
    const anchorAt = new Date(2026, 7, 17, 8, 5).getTime();
    const routine = h.manager.create({
      name: "Frequent check",
      prompt: "Check the queue",
      botId: "maus-1",
      schedule: { type: "interval", everyMinutes: 5, anchorAt },
    });

    expect(routine.schedule).toEqual({ type: "interval", everyMinutes: 5, anchorAt });
    expect(routine.nextRunAt).toBe(anchorAt);
    expect(() => h.manager.create({
      name: "Too frequent",
      prompt: "Check too often",
      botId: "maus-1",
      schedule: { type: "interval", everyMinutes: 4, anchorAt },
    })).toThrow(/5 to 1440/);
    for (const invalidAnchor of [1.5, Number.MAX_SAFE_INTEGER, Number.NaN]) {
      expect(() => h.manager.create({
        name: "Bad anchor",
        prompt: "Check later",
        botId: "maus-1",
        schedule: { type: "interval", everyMinutes: 5, anchorAt: invalidAnchor },
      })).toThrow(/valid interval start time/);
    }
  });

  it("validates and normalizes interval restrictions", () => {
    const h = harness();
    const anchorAt = new Date(2026, 7, 17, 8, 5).getTime();
    const endsAt = new Date(2026, 7, 31, 23, 59).getTime();
    const input = {
      name: "Restricted check",
      prompt: "Check during support hours",
      botId: "maus-1",
    };
    const routine = h.manager.create({
      ...input,
      schedule: {
        type: "interval",
        everyMinutes: 30,
        anchorAt,
        weekdays: [5, 1, 3],
        window: { start: "09:00", end: "17:00" },
        endsAt,
      },
    });

    expect(routine.schedule).toEqual({
      type: "interval",
      everyMinutes: 30,
      anchorAt,
      weekdays: [1, 3, 5],
      window: { start: "09:00", end: "17:00" },
      endsAt,
    });
    expect(h.manager.create({
      ...input,
      name: "Every day",
      schedule: {
        type: "interval",
        everyMinutes: 30,
        anchorAt,
        weekdays: [6, 5, 4, 3, 2, 1, 0],
      },
    }).schedule).toEqual({ type: "interval", everyMinutes: 30, anchorAt });

    const invalidSchedules = [
      { type: "interval" as const, everyMinutes: 30, anchorAt, weekdays: [] },
      { type: "interval" as const, everyMinutes: 30, anchorAt, weekdays: [1, 1] },
      { type: "interval" as const, everyMinutes: 30, anchorAt, weekdays: [7] },
      { type: "interval" as const, everyMinutes: 30, anchorAt, window: { start: "9:00", end: "17:00" } },
      { type: "interval" as const, everyMinutes: 30, anchorAt, window: { start: "17:00", end: "09:00" } },
      { type: "interval" as const, everyMinutes: 60, anchorAt, window: { start: "09:00", end: "09:30" } },
      { type: "interval" as const, everyMinutes: 30, anchorAt, endsAt: anchorAt - 1 },
    ];
    for (const [index, schedule] of invalidSchedules.entries()) {
      expect(() => h.manager.create({ ...input, name: `Invalid ${index}`, schedule })).toThrow();
    }
  });

  it("preserves interval restrictions for legacy schedule updates and clears explicit nulls", () => {
    const h = harness();
    const anchorAt = new Date(2026, 7, 17, 8, 5).getTime();
    const endsAt = new Date(2026, 7, 31, 23, 59).getTime();
    const routine = h.manager.create({
      name: "Restricted check",
      prompt: "Check during support hours",
      botId: "maus-1",
      schedule: {
        type: "interval",
        everyMinutes: 30,
        anchorAt,
        weekdays: [1, 3, 5],
        window: { start: "09:00", end: "17:00" },
        endsAt,
      },
    });

    const legacyUpdate = h.manager.update(routine.id, {
      name: "Renamed on an older phone",
      schedule: { type: "interval", everyMinutes: 60, anchorAt },
    });
    expect(legacyUpdate?.schedule).toEqual({
      type: "interval",
      everyMinutes: 60,
      anchorAt,
      weekdays: [1, 3, 5],
      window: { start: "09:00", end: "17:00" },
      endsAt,
    });

    const cleared = h.manager.update(routine.id, {
      schedule: {
        type: "interval",
        everyMinutes: 60,
        anchorAt,
        weekdays: null,
        window: null,
        endsAt: null,
      },
    });
    expect(cleared?.schedule).toEqual({ type: "interval", everyMinutes: 60, anchorAt });
  });

  it("rejects enabled intervals without a future run but allows them while disabled", () => {
    const now = new Date(2026, 7, 17, 8, 0, 0).getTime();
    const h = harness(now);
    const expiredSchedule = {
      type: "interval" as const,
      everyMinutes: 5,
      anchorAt: now - 60 * 60_000,
      endsAt: now - 30 * 60_000,
    };
    const input = {
      name: "Expired check",
      prompt: "Check only before the cutoff",
      botId: "maus-1",
      schedule: expiredSchedule,
    };

    expect(() => h.manager.create(input)).toThrow(
      "This interval has no future runs. Choose a later end date or turn it off.",
    );
    const disabled = h.manager.create({ ...input, enabled: false });
    expect(disabled).toMatchObject({ enabled: false, nextRunAt: null, schedule: expiredSchedule });

    const active = h.manager.create({
      ...input,
      name: "Active check",
      schedule: {
        type: "interval",
        everyMinutes: 5,
        anchorAt: now + 5 * 60_000,
        endsAt: now + 10 * 60_000,
      },
    });
    expect(() => h.manager.update(active.id, { schedule: expiredSchedule })).toThrow(
      "This interval has no future runs. Choose a later end date or turn it off.",
    );
    expect(h.manager.listRoutines().find((routine) => routine.id === active.id)?.enabled).toBe(true);

    const paused = h.manager.update(active.id, { enabled: false, schedule: expiredSchedule });
    expect(paused).toMatchObject({ enabled: false, nextRunAt: null, schedule: expiredSchedule });
  });

  it("stores routine data with owner-only permissions", () => {
    const h = harness();
    h.manager.create({
      name: "Private routine",
      prompt: "Keep this private",
      botId: "maus-private",
      schedule: { type: "daily", time: "09:00", weekdays: [1] },
    });

    if (process.platform !== "win32") {
      expect(statSync(h.options.file!).mode & 0o777).toBe(0o600);
    }
  });

  it("persists definitions separately from permanent run receipts", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Morning brief",
      prompt: "Summarize what changed",
      botId: "maus-1",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 5).getTime() },
      timeoutMinutes: 15,
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();

    const routineFile = h.options.file;
    if (!routineFile) throw new Error("test harness did not configure routine persistence");
    let failureWasPersistedBeforeCallback = false;
    h.options.onRunFailed = (run) => {
      h.failed.push(run);
      failureWasPersistedBeforeCallback = readFileSync(routineFile, "utf8").includes('"status": "failed"');
    };
    const reloaded = new RoutineManager(h.options);
    expect(reloaded.listRoutines()).toHaveLength(1);
    expect(reloaded.listRuns()).toMatchObject([
      {
        routineId: routine.id,
        routineName: "Morning brief",
        status: "failed",
        threadId: "thread-1",
        timeoutMinutes: 15,
      },
    ]);
    // Reload recovery truthfully marks an in-process run as interrupted.
    expect(reloaded.listRuns()[0]!.error).toContain("restarted");
    expect(failureWasPersistedBeforeCallback).toBe(true);
    expect(h.failed).toMatchObject([
      {
        routineId: routine.id,
        routineName: "Morning brief",
        status: "failed",
        threadId: "thread-1",
        error: "OpenMausBot restarted while this routine was running",
      },
    ]);
  });

  it("migrates optional attachment and timeout metadata without losing legacy records", () => {
    const h = harness();
    h.setBot("busy");
    const routine = h.manager.create({
      name: "Review attachment",
      prompt: "Review the supplied context",
      botId: "maus-attachments",
      schedule: { type: "daily", time: "09:00", weekdays: [1] },
      attachments: [{
        id: "file-1",
        kind: "file",
        name: "brief.pdf",
        path: "/tmp/brief.pdf",
        size: 4_096,
      }],
    });
    h.manager.runNow(routine.id);

    const persisted = new RoutineManager(h.options);
    expect(persisted.listRoutines()[0]?.attachments).toEqual([{
      id: "file-1",
      kind: "file",
      name: "brief.pdf",
      path: "/tmp/brief.pdf",
      size: 4_096,
    }]);
    expect(persisted.listRuns()[0]?.attachments).toEqual(persisted.listRoutines()[0]?.attachments);

    const file = h.options.file!;
    const oldFile = JSON.parse(readFileSync(file, "utf8")) as {
      routines: Array<{ attachments?: unknown; timeoutMinutes?: unknown }>;
      runs: Array<{ attachments?: unknown; timeoutMinutes?: unknown }>;
    };
    delete oldFile.routines[0]!.attachments;
    delete oldFile.runs[0]!.attachments;
    oldFile.routines[0]!.timeoutMinutes = 2;
    oldFile.runs[0]!.timeoutMinutes = "invalid";
    writeFileSync(file, JSON.stringify(oldFile));

    const migrated = new RoutineManager(h.options);
    expect(migrated.listRoutines()[0]?.attachments).toEqual([]);
    expect(migrated.listRuns()[0]?.attachments).toEqual([]);
    expect(migrated.listRoutines()[0]).not.toHaveProperty("timeoutMinutes");
    expect(migrated.listRuns()[0]).not.toHaveProperty("timeoutMinutes");
  });

  it("migrates routines and run receipts without a target to bot execution", () => {
    const h = harness();
    h.setBot("busy");
    const routine = h.manager.create({
      name: "Legacy bot routine",
      prompt: "Keep running as a bot",
      botId: "maus-legacy",
      schedule: { type: "daily", time: "09:00", weekdays: [1] },
    });
    h.manager.runNow(routine.id);

    const stored = JSON.parse(readFileSync(h.options.file!, "utf8")) as {
      routines: Array<{ target?: unknown; groupId?: unknown }>;
      runs: Array<{ target?: unknown; groupId?: unknown }>;
    };
    delete stored.routines[0]!.target;
    delete stored.runs[0]!.target;
    stored.routines[0]!.groupId = "stale-room";
    stored.runs[0]!.groupId = "stale-room";
    writeFileSync(h.options.file!, JSON.stringify(stored));

    const migrated = new RoutineManager(h.options);
    expect(migrated.listRoutines()[0]).toMatchObject({ target: "bot", botId: "maus-legacy" });
    expect(migrated.listRoutines()[0]?.groupId).toBeUndefined();
    expect(migrated.listRuns()[0]).toMatchObject({ target: "bot", botId: "maus-legacy" });
    expect(migrated.listRuns()[0]?.groupId).toBeUndefined();
  });

  it("ignores one malformed persisted interval without hiding valid routines", () => {
    const h = harness();
    const anchorAt = new Date(2026, 7, 17, 8, 5).getTime();
    const malformed = h.manager.create({
      name: "Malformed interval",
      prompt: "Never load this cadence",
      botId: "maus-legacy",
      schedule: { type: "interval", everyMinutes: 5, anchorAt },
    });
    const valid = h.manager.create({
      name: "Valid interval",
      prompt: "Keep this cadence",
      botId: "maus-valid",
      schedule: { type: "interval", everyMinutes: 15, anchorAt },
    });
    const stored = JSON.parse(readFileSync(h.options.file!, "utf8")) as {
      routines: Array<{ id: string; schedule: { anchorAt?: unknown } }>;
    };
    stored.routines.find((routine) => routine.id === malformed.id)!.schedule.anchorAt = Number.MAX_SAFE_INTEGER;
    writeFileSync(h.options.file!, JSON.stringify(stored));

    const reloaded = new RoutineManager(h.options);
    expect(reloaded.listRoutines()).toMatchObject([{ id: valid.id, name: "Valid interval" }]);
  });

  it("persists confirmation receipts with the scheduler mutation and removes them after settlement", () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Before",
      prompt: "Review the queue",
      botId: "maus-1",
      schedule: { type: "daily", time: "09:00", weekdays: [1] },
    });
    const request = {
      requestId: "request-update-1",
      messageId: "message-1",
      botId: "maus-1",
      threadId: "thread-1",
      action: "update" as const,
      fingerprintVersion: 1 as const,
      fingerprint: "a".repeat(64),
    };
    h.manager.update(routine.id, { name: "After" }, request);

    const reloaded = new RoutineManager(h.options);
    expect(reloaded.routineRequestReceipt(request.requestId)).toMatchObject({
      ...request,
      resultId: routine.id,
    });
    expect(reloaded.routineRequestReceiptOwners()).toEqual([{
      requestId: request.requestId,
      messageId: request.messageId,
      botId: request.botId,
      threadId: request.threadId,
    }]);
    expect(() => reloaded.update(routine.id, { name: "Never applied" }, {
      ...request,
      fingerprint: "b".repeat(64),
    })).toThrow(/does not match/);
    expect(reloaded.listRoutines()[0]!.name).toBe("After");

    expect(reloaded.reconcileRoutineRequestReceipts([request])).toBe(0);
    expect(reloaded.forgetRoutineRequestReceipt(request)).toBe(true);
    expect(new RoutineManager(h.options).routineRequestReceipt(request.requestId)).toBeNull();
  });

  it("persists trusted chat provenance and snapshots it onto detached runs", async () => {
    const h = harness();
    const request = {
      requestId: "request-source-thread",
      messageId: "message-source-thread",
      botId: "maus-1",
      threadId: "conversation-that-created-it",
      action: "create" as const,
      fingerprintVersion: 1 as const,
      fingerprint: "e".repeat(64),
    };
    const routine = h.manager.create({
      name: "Source report",
      prompt: "Summarize the queue",
      botId: "maus-1",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 5).getTime() },
    }, request);

    expect(routine.sourceThreadId).toBe(request.threadId);
    const reloaded = new RoutineManager(h.options);
    expect(reloaded.listRoutines()[0]?.sourceThreadId).toBe(request.threadId);

    h.setNow(routine.nextRunAt!);
    await reloaded.tick();
    const run = reloaded.listRuns()[0]!;
    expect(run).toMatchObject({
      sourceThreadId: request.threadId,
      threadId: "thread-1",
      status: "running",
    });
    expect(run.threadId).not.toBe(run.sourceThreadId);
    expect(h.changed.map(({ status, sourceThreadId, threadId }) => ({ status, sourceThreadId, threadId })))
      .toEqual([
        { status: "queued", sourceThreadId: request.threadId, threadId: undefined },
        { status: "running", sourceThreadId: request.threadId, threadId: "thread-1" },
      ]);
  });

  it("does not trust a calendar payload to choose another conversation", () => {
    const h = harness();
    const schedule: RoutineSchedule = { type: "daily", time: "09:00", weekdays: [1] };
    const calendarPayload = {
      name: "Calendar-owned",
      prompt: "Run without a chat source",
      botId: "maus-1",
      schedule,
      sourceThreadId: "forged-thread",
    };
    const routine = h.manager.create(calendarPayload);
    expect(routine.sourceThreadId).toBeUndefined();
  });

  it("keeps routine history when a persisted source thread is malformed", () => {
    const h = harness();
    const request = {
      requestId: "request-malformed-source",
      messageId: "message-malformed-source",
      botId: "maus-1",
      threadId: "trusted-source",
      action: "create" as const,
      fingerprintVersion: 1 as const,
      fingerprint: "2".repeat(64),
    };
    h.manager.create({
      name: "Survives malformed provenance",
      prompt: "Keep this routine",
      botId: "maus-1",
      schedule: { type: "daily", time: "09:00", weekdays: [1] },
    }, request);
    const file = h.options.file;
    if (!file) throw new Error("test harness did not configure routine persistence");
    const stored = readFileSync(file, "utf8");
    const malformed = stored.replace(`"sourceThreadId": "${request.threadId}"`, '"sourceThreadId": 42');
    expect(malformed).not.toBe(stored);
    writeFileSync(file, malformed);

    const reloaded = new RoutineManager(h.options);
    expect(reloaded.listRoutines()).toMatchObject([{
      name: "Survives malformed provenance",
      sourceThreadId: undefined,
    }]);
  });

  it("reports a chat-confirmed run-now to its invoking thread without rebinding the routine", () => {
    const h = harness();
    const createRequest = {
      requestId: "request-create-origin",
      messageId: "message-create-origin",
      botId: "maus-1",
      threadId: "original-thread",
      action: "create" as const,
      fingerprintVersion: 1 as const,
      fingerprint: "f".repeat(64),
    };
    const routine = h.manager.create({
      name: "Daily source",
      prompt: "Review it",
      botId: "maus-1",
      schedule: { type: "daily", time: "09:00", weekdays: [1] },
    }, createRequest);
    const runRequest = {
      ...createRequest,
      requestId: "request-run-now-elsewhere",
      messageId: "message-run-now-elsewhere",
      threadId: "invoking-thread",
      action: "run_now" as const,
      fingerprint: "1".repeat(64),
    };

    const run = h.manager.runNow(routine.id, runRequest)!;
    expect(run.sourceThreadId).toBe("invoking-thread");
    expect(h.manager.listRoutines()[0]?.sourceThreadId).toBe("original-thread");
  });

  it("removes unreachable recovery receipts when their conversation is deleted", () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Cleanup",
      prompt: "Clean unreachable confirmations",
      botId: "maus-1",
      schedule: { type: "daily", time: "09:00", weekdays: [1] },
    });
    const request = {
      requestId: "request-orphaned-thread",
      messageId: "message-orphaned-thread",
      botId: "maus-1",
      threadId: "thread-deleted",
      action: "pause" as const,
      fingerprintVersion: 1 as const,
      fingerprint: "d".repeat(64),
    };
    h.manager.update(routine.id, { enabled: false }, request);

    expect(h.manager.forgetRoutineRequestReceiptsForThread("another-thread")).toBe(0);
    expect(h.manager.forgetRoutineRequestReceiptsForThread("thread-deleted")).toBe(1);
    expect(new RoutineManager(h.options).routineRequestReceipt(request.requestId)).toBeNull();
  });

  it("rolls back an uncommitted confirmation when the atomic file write fails", () => {
    const h = harness();
    const file = h.options.file!;
    // A directory at the destination makes the final atomic rename fail
    // after the temporary file has been written.
    mkdirSync(file);
    const request = {
      requestId: "request-create-write-failure",
      messageId: "message-write-failure",
      botId: "maus-1",
      threadId: "thread-1",
      action: "create" as const,
      fingerprintVersion: 1 as const,
      fingerprint: "c".repeat(64),
    };
    const input = {
      name: "Retry safely",
      prompt: "Check the queue",
      botId: "maus-1",
      schedule: { type: "daily" as const, time: "09:00", weekdays: [1] },
    };

    expect(() => h.manager.create(input, request)).toThrow();
    expect(h.manager.listRoutines()).toEqual([]);
    expect(h.manager.routineRequestReceipt(request.requestId)).toBeNull();
    expect(h.emitted).toEqual([]);

    rmSync(file, { recursive: true, force: true });
    rmSync(`${file}.tmp`, { force: true });
    const routine = h.manager.create(input, request);
    expect(h.manager.listRoutines()).toHaveLength(1);
    expect(h.manager.routineRequestReceipt(request.requestId)).toMatchObject({
      ...request,
      resultId: routine.id,
    });
  });

  it("queues behind a busy bot, then dispatches into a detached task", async () => {
    const h = harness();
    h.setBot("busy");
    const routine = h.manager.create({
      name: "Review queue",
      prompt: "Review the queue",
      botId: "maus-2",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
      durationMinutes: 45,
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    expect(h.manager.listRuns()[0]!.status).toBe("queued");
    expect(h.started).toHaveLength(0);

    h.setBot("ready");
    await h.manager.tick();
    expect(h.started).toEqual([{ botId: "maus-2", threadId: "thread-1", prompt: "Review the queue" }]);
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "running", threadId: "thread-1" });
    expect(h.manager.activeRunForBot("maus-2")?.threadId).toBe("thread-1");
    expect(h.manager.isActiveThread("thread-1")).toBe(true);
    expect(h.taskActivations).toEqual([false]);
  });

  it("skips interval ticks while the previous run is still active", async () => {
    const h = harness();
    const anchorAt = new Date(2026, 7, 17, 8, 5).getTime();
    h.manager.create({
      name: "Frequent check",
      prompt: "Check the queue",
      botId: "maus-interval",
      schedule: { type: "interval", everyMinutes: 5, anchorAt },
      durationMinutes: 30,
    });

    h.setNow(anchorAt);
    await h.manager.tick();
    expect(h.manager.listRuns()).toHaveLength(1);
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "running", scheduledFor: anchorAt });

    h.setNow(anchorAt + 5 * 60_000);
    await h.manager.tick();
    expect(h.manager.listRuns()).toHaveLength(1);
    expect(h.manager.listRoutines()[0]?.nextRunAt).toBe(anchorAt + 10 * 60_000);

    h.manager.failThread("thread-1", "Finished test run");
    h.setNow(anchorAt + 10 * 60_000);
    await h.manager.tick();
    expect(h.manager.listRuns()).toHaveLength(2);
    expect(h.started).toHaveLength(2);
  });

  it("catches up at most the latest interval occurrence without a backlog", async () => {
    const h = harness();
    const anchorAt = new Date(2026, 7, 17, 8, 5).getTime();
    h.manager.create({
      name: "Frequent check",
      prompt: "Check the queue",
      botId: "maus-interval",
      schedule: { type: "interval", everyMinutes: 5, anchorAt },
    });

    h.setNow(anchorAt + 12 * 60_000);
    await h.manager.tick();

    expect(h.manager.listRuns()).toMatchObject([{
      status: "running",
      scheduledFor: anchorAt + 10 * 60_000,
    }]);
    expect(h.manager.listRoutines()[0]?.nextRunAt).toBe(anchorAt + 15 * 60_000);
  });

  it("catches up to the latest allowed restricted interval occurrence", async () => {
    const mondayAtEight = new Date(2026, 7, 17, 8, 0, 0).getTime();
    const h = harness(mondayAtEight);
    h.manager.create({
      name: "Support-hours check",
      prompt: "Check the support queue",
      botId: "maus-interval",
      schedule: {
        type: "interval",
        everyMinutes: 30,
        anchorAt: mondayAtEight,
        weekdays: [1],
        window: { start: "09:00", end: "10:30" },
      },
    });

    h.setNow(new Date(2026, 7, 17, 10, 20, 0).getTime());
    await h.manager.tick();

    expect(h.manager.listRuns()).toMatchObject([{
      status: "running",
      scheduledFor: new Date(2026, 7, 17, 10, 0, 0).getTime(),
    }]);
    expect(h.manager.listRoutines()[0]?.nextRunAt).toBe(new Date(2026, 7, 24, 9, 0, 0).getTime());
  });

  it("rebases a scheduled interval queued behind a busy bot before dispatch", async () => {
    const h = harness();
    h.setBot("busy");
    const anchorAt = new Date(2026, 7, 17, 8, 5).getTime();
    h.manager.create({
      name: "Frequent check",
      prompt: "Check the latest queue",
      botId: "maus-interval",
      schedule: { type: "interval", everyMinutes: 5, anchorAt },
    });

    h.setNow(anchorAt);
    await h.manager.tick();
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "queued", scheduledFor: anchorAt });

    const readyAt = anchorAt + 12 * 60 * 60_000 + 7 * 60_000;
    const latestAt = anchorAt + 12 * 60 * 60_000 + 5 * 60_000;
    h.setNow(readyAt);
    h.setBot("ready");
    await h.manager.tick();

    expect(h.manager.listRuns()).toMatchObject([{
      status: "running",
      scheduledFor: latestAt,
      threadId: "thread-1",
    }]);
    expect(h.started).toEqual([{
      botId: "maus-interval",
      threadId: "thread-1",
      prompt: "Check the latest queue",
    }]);
  });

  it("holds a queued restricted interval outside its window and dispatches in the next window", async () => {
    const mondayAtEight = new Date(2026, 7, 17, 8, 0, 0).getTime();
    const h = harness(mondayAtEight);
    h.setBot("busy");
    h.manager.create({
      name: "Business-hours check",
      prompt: "Check at an allowed time",
      botId: "maus-interval",
      schedule: {
        type: "interval",
        everyMinutes: 30,
        anchorAt: mondayAtEight,
        weekdays: [1],
        window: { start: "09:00", end: "10:30" },
      },
    });

    h.setNow(new Date(2026, 7, 17, 10, 0, 0).getTime());
    await h.manager.tick();
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "queued" });

    h.setNow(new Date(2026, 7, 17, 11, 0, 0).getTime());
    h.setBot("ready");
    await h.manager.tick();
    expect(h.started).toHaveLength(0);
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "queued" });

    const nextMondayAtNine = new Date(2026, 7, 24, 9, 0, 0).getTime();
    h.setNow(nextMondayAtNine);
    await h.manager.tick();
    expect(h.started).toEqual([{
      botId: "maus-interval",
      threadId: "thread-1",
      prompt: "Check at an allowed time",
    }]);
    expect(h.manager.listRuns()[0]).toMatchObject({
      status: "running",
      scheduledFor: nextMondayAtNine,
    });
  });

  it("waits for the first aligned occurrence in a new allowed window before dispatching a carried queue", async () => {
    const mondayAtEightOhFive = new Date(2026, 7, 17, 8, 5, 0).getTime();
    const h = harness(mondayAtEightOhFive);
    h.setBot("busy");
    h.manager.create({
      name: "Phase-aligned check",
      prompt: "Keep the original cadence",
      botId: "maus-interval",
      schedule: {
        type: "interval",
        everyMinutes: 30,
        anchorAt: mondayAtEightOhFive,
        weekdays: [1],
        window: { start: "09:00", end: "10:30" },
      },
    });

    const firstMondayAtTenOhFive = new Date(2026, 7, 17, 10, 5, 0).getTime();
    h.setNow(firstMondayAtTenOhFive);
    await h.manager.tick();
    expect(h.manager.listRuns()[0]).toMatchObject({
      status: "queued",
      scheduledFor: firstMondayAtTenOhFive,
    });

    h.setBot("ready");
    h.setNow(new Date(2026, 7, 24, 9, 1, 0).getTime());
    await h.manager.tick();
    expect(h.started).toHaveLength(0);
    expect(h.manager.listRuns()[0]).toMatchObject({
      status: "queued",
      scheduledFor: firstMondayAtTenOhFive,
    });

    const nextMondayAtNineOhFive = new Date(2026, 7, 24, 9, 5, 0).getTime();
    h.setNow(nextMondayAtNineOhFive);
    await h.manager.tick();
    expect(h.started).toEqual([{
      botId: "maus-interval",
      threadId: "thread-1",
      prompt: "Keep the original cadence",
    }]);
    expect(h.manager.listRuns()[0]).toMatchObject({
      status: "running",
      scheduledFor: nextMondayAtNineOhFive,
    });
  });

  it("disables an exhausted interval and marks its still-queued final run missed", async () => {
    const start = new Date(2026, 7, 17, 8, 0, 0).getTime();
    const finalOccurrence = start + 5 * 60_000;
    const h = harness(start);
    h.setBot("busy");
    h.manager.create({
      name: "Short-lived check",
      prompt: "Run before the cutoff",
      botId: "maus-interval",
      schedule: {
        type: "interval",
        everyMinutes: 5,
        anchorAt: start,
        endsAt: finalOccurrence,
      },
    });

    h.setNow(finalOccurrence);
    await h.manager.tick();
    expect(h.manager.listRoutines()[0]).toMatchObject({ enabled: false, nextRunAt: null });
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "queued", scheduledFor: finalOccurrence });

    h.setNow(finalOccurrence + 60_000);
    h.setBot("ready");
    await h.manager.tick();
    expect(h.started).toHaveLength(0);
    expect(h.manager.listRuns()[0]).toMatchObject({
      status: "missed",
      error: "The routine ended before this scheduled run could start",
    });
  });

  it("preserves exact timestamps for manual and webhook interval work", async () => {
    const start = new Date(2026, 7, 17, 8, 0).getTime();
    const manualHarness = harness(start);
    manualHarness.setBot("busy");
    const manualRoutine = manualHarness.manager.create({
      name: "Manual interval check",
      prompt: "Run exactly when requested",
      botId: "maus-manual",
      schedule: { type: "interval", everyMinutes: 5, anchorAt: start },
    });
    const manual = manualHarness.manager.runNow(manualRoutine.id)!;
    manualHarness.setNow(start + 13 * 60 * 60_000);
    manualHarness.setBot("ready");
    await manualHarness.manager.tick();
    expect(manualHarness.manager.listRuns().find((run) => run.id === manual.id)).toMatchObject({
      triggerSource: "manual",
      scheduledFor: start,
      status: "running",
    });

    const webhookHarness = harness(start);
    webhookHarness.setBot("busy");
    const webhookRoutine = webhookHarness.manager.create({
      name: "Webhook id collision",
      prompt: "Keep the delivery timestamp",
      botId: "maus-webhook",
      schedule: { type: "interval", everyMinutes: 5, anchorAt: start },
    });
    const webhook = webhookHarness.manager.enqueueWebhook({
      webhookId: webhookRoutine.id,
      webhookName: "Incoming delivery",
      prompt: "Handle the delivery",
      botId: "maus-webhook",
      runOn: "maus",
      deliveryId: "delivery-exact",
      receivedAt: start,
    });
    webhookHarness.setNow(start + 13 * 60 * 60_000);
    webhookHarness.setBot("ready");
    await webhookHarness.manager.tick();
    expect(webhookHarness.manager.listRuns().find((run) => run.id === webhook.id)).toMatchObject({
      triggerSource: "webhook",
      scheduledFor: start,
      status: "running",
    });
  });

  it("retains an old waiting run when trimming terminal receipt history", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Waiting approval",
      prompt: "Wait for approval",
      botId: "maus-waiting",
      schedule: { type: "daily", time: "23:59", weekdays: [1] },
    });
    const waiting = h.manager.runNow(routine.id)!;
    await h.manager.tick();
    h.manager.handleRuntimeEvent({
      eventId: "waiting-request",
      provider: "fake",
      threadId: "thread-1",
      createdAt: new Date().toISOString(),
      type: "request.opened",
      requestType: "permission",
      tool: "write",
      summary: "Approve the write",
    });

    // Seed terminal history directly so this capacity regression does not do
    // two thousand quadratic fixture writes. The final enqueue still crosses
    // the real manager save/retention path that used to evict index zero.
    const internal = h.manager as unknown as { runs: RoutineRun[] };
    const base = internal.runs.find((run) => run.id === waiting.id)!;
    for (let index = 0; index < 1_999; index += 1) {
      internal.runs.push({
        ...base,
        id: `terminal-${index}`,
        status: "completed",
        attention: undefined,
        finishedAt: index + 1,
      });
    }
    h.setBot("busy");
    const queued = h.manager.enqueueWebhook({
      webhookId: "hook-capacity",
      webhookName: "Capacity check",
      prompt: "Keep active receipts",
      botId: "maus-capacity",
      runOn: "maus",
      deliveryId: "delivery-capacity",
      receivedAt: 2_001,
    });

    const retained = h.manager.listRuns();
    expect(retained).toHaveLength(2_000);
    expect(retained.some((run) => run.id === waiting.id && run.status === "waiting")).toBe(true);
    expect(retained.some((run) => run.id === queued.id && run.status === "queued")).toBe(true);
    expect(retained.some((run) => run.id === "terminal-0")).toBe(false);
  });

  it("enforces only the optional run limit from the actual start time", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Bounded check",
      prompt: "Check the queue",
      botId: "maus-timeout",
      schedule: { type: "daily", time: "23:59", weekdays: [1] },
      durationMinutes: 90,
      timeoutMinutes: 5,
    });
    const run = h.manager.runNow(routine.id)!;
    await h.manager.tick();
    const startedAt = h.manager.listRuns().find((candidate) => candidate.id === run.id)?.startedAt;
    expect(startedAt).toBeDefined();

    h.setNow(startedAt! + 5 * 60_000);
    await h.manager.tick();

    expect(h.manager.listRuns().find((candidate) => candidate.id === run.id)).toMatchObject({
      status: "failed",
      error: "Stopped after reaching the 5-minute run limit",
      finishedAt: startedAt! + 5 * 60_000,
    });
    expect(h.interruptedTurns).toEqual([
      { botId: "maus-timeout", threadId: "thread-1", runOn: "maus" },
    ]);
  });

  it("keeps legacy duration metadata without imposing a timeout", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Unbounded check",
      prompt: "Keep checking",
      botId: "maus-unbounded",
      schedule: { type: "daily", time: "23:59", weekdays: [1] },
      durationMinutes: 5,
    });
    const run = h.manager.runNow(routine.id)!;
    await h.manager.tick();
    const startedAt = h.manager.listRuns().find((candidate) => candidate.id === run.id)?.startedAt;
    h.setNow(startedAt! + 6 * 60_000);
    await h.manager.tick();

    expect(h.manager.listRuns().find((candidate) => candidate.id === run.id)).toMatchObject({
      status: "running",
      durationMinutes: 5,
    });
    expect(h.manager.listRuns().find((candidate) => candidate.id === run.id)).not.toHaveProperty("timeoutMinutes");
    expect(h.interruptedTurns).toEqual([]);
  });

  it("reports a timed-out room goal as limit-reached", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Bounded team goal",
      prompt: "Coordinate until the limit",
      target: "room-goal",
      botId: "chief-1",
      groupId: "room-1",
      schedule: { type: "daily", time: "23:59", weekdays: [1] },
      timeoutMinutes: 5,
    });
    const run = h.manager.runNow(routine.id)!;
    await h.manager.tick();
    const startedAt = h.manager.listRuns().find((candidate) => candidate.id === run.id)?.startedAt;
    h.setNow(startedAt! + 5 * 60_000);
    await h.manager.tick();

    expect(h.manager.listRuns().find((candidate) => candidate.id === run.id)).toMatchObject({
      status: "failed",
      goalStatus: "limit-reached",
      error: "Stopped after reaching the 5-minute run limit",
    });
    expect(h.interruptedGoals).toEqual([{
      groupId: "room-1",
      threadId: "goal-thread-1",
      outcome: {
        status: "limit-reached",
        detail: "Stopped after reaching the 5-minute run limit",
      },
    }]);
  });

  it("distinguishes direct bot work from room goals coordinated by the same bot", async () => {
    const h = harness();
    const roomRoutine = h.manager.create({
      name: "Coordinate launch",
      prompt: "Coordinate the room",
      target: "room-goal",
      botId: "chief-1",
      groupId: "room-1",
      schedule: { type: "daily", time: "09:00", weekdays: [1] },
    });
    const roomRun = h.manager.runNow(roomRoutine.id)!;
    await h.manager.tick();

    expect(h.manager.activeRunForBot("chief-1")?.id).toBe(roomRun.id);
    expect(h.manager.activeBotRunForBot("chief-1")).toBeNull();

    const botRoutine = h.manager.create({
      name: "Private brief",
      prompt: "Prepare the private brief",
      botId: "chief-1",
      schedule: { type: "daily", time: "09:00", weekdays: [1] },
    });
    const botRun = h.manager.runNow(botRoutine.id)!;
    await h.manager.tick();

    expect(h.manager.activeRunForBot("chief-1")?.id).toBe(roomRun.id);
    expect(h.manager.activeBotRunForBot("chief-1")?.id).toBe(botRun.id);
    expect(h.manager.activeBotRunForBot("another-bot")).toBeNull();
  });

  it("queues behind a busy room goal, then dispatches it into a detached room task", async () => {
    const h = harness();
    h.setGoal("busy");
    const routine = h.manager.create({
      name: "Team launch",
      prompt: "Prepare and verify the launch",
      target: "room-goal",
      botId: "chief-1",
      groupId: "room-1",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();

    expect(h.manager.listRuns()[0]).toMatchObject({
      status: "queued",
      target: "room-goal",
      groupId: "room-1",
      botId: "chief-1",
    });
    expect(h.startedGoals).toHaveLength(0);

    h.manager.update(routine.id, { target: "bot", groupId: null });
    h.setGoal("ready");
    await h.manager.tick();
    const run = h.manager.listRuns()[0]!;
    expect(h.goalTasks).toEqual([{ groupId: "room-1", title: "Team launch" }]);
    expect(h.startedGoals[0]).toMatchObject({
      groupId: "room-1",
      threadId: "goal-thread-1",
      prompt: "Prepare and verify the launch",
      coordinatorBotId: "chief-1",
      runId: run.id,
    });
    expect(run).toMatchObject({ status: "running", threadId: "goal-thread-1" });
    expect(h.manager.listRoutines()[0]).toMatchObject({ target: "bot", groupId: undefined });
    expect(h.taskActivations).toEqual([]);
  });

  it("fails a queued room goal when its room or coordinator disappears", async () => {
    const h = harness();
    h.setGoal("busy");
    const routine = h.manager.create({
      name: "Team launch",
      prompt: "Prepare the launch",
      target: "room-goal",
      botId: "chief-1",
      groupId: "room-1",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    h.setGoal("missing");
    await h.manager.tick();

    expect(h.manager.listRuns()[0]).toMatchObject({
      status: "failed",
      error: "The assigned room or coordinator no longer exists",
    });
    expect(h.startedGoals).toHaveLength(0);
  });

  it("cancels queued work when a routine is paused", async () => {
    const h = harness();
    h.setBot("busy");
    const routine = h.manager.create({
      name: "Pauseable check",
      prompt: "Check later",
      botId: "maus-2",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();

    h.manager.update(routine.id, { enabled: false });
    h.setBot("ready");
    await h.manager.tick();

    expect(h.manager.listRuns()[0]).toMatchObject({ status: "cancelled" });
    expect(h.started).toHaveLength(0);
  });

  it("disables a deleted room's routines and cancels only that room's active run snapshots", async () => {
    const h = harness();
    const schedule = { type: "daily" as const, time: "23:59", weekdays: [1] };
    const roomRoutine = h.manager.create({
      name: "Room one goal",
      prompt: "Work together",
      target: "room-goal",
      botId: "chief-1",
      groupId: "room-1",
      schedule,
    });
    const pausedRoomRoutine = h.manager.create({
      name: "Already paused",
      prompt: "Stay paused",
      target: "room-goal",
      botId: "chief-1",
      groupId: "room-1",
      enabled: false,
      schedule,
    });
    const otherRoomRoutine = h.manager.create({
      name: "Room two goal",
      prompt: "Keep working elsewhere",
      target: "room-goal",
      botId: "chief-1",
      groupId: "room-2",
      schedule,
    });
    const botRoutine = h.manager.create({
      name: "Chief's private task",
      prompt: "Keep the direct task running",
      botId: "chief-1",
      schedule,
    });

    const waitingRun = h.manager.runNow(roomRoutine.id)!;
    await h.manager.tick();
    h.manager.handleRuntimeEvent({
      eventId: "room-waiting",
      provider: "fake",
      threadId: "goal-thread-1",
      createdAt: new Date().toISOString(),
      type: "request.opened",
      requestType: "question",
      tool: "ask",
      summary: "Choose an approach",
    });
    const runningRun = h.manager.runNow(roomRoutine.id)!;
    await h.manager.tick();
    const otherRoomRun = h.manager.runNow(otherRoomRoutine.id)!;
    await h.manager.tick();
    const botRun = h.manager.runNow(botRoutine.id)!;
    await h.manager.tick();
    h.setGoal("busy");
    const queuedRun = h.manager.runNow(roomRoutine.id)!;
    await h.manager.tick();

    const pausedBefore = h.manager.listRoutines().find((routine) => routine.id === pausedRoomRoutine.id)!;
    h.emitted.length = 0;
    h.changed.length = 0;
    h.interruptedGoals.length = 0;
    h.manager.disableForGroup("room-1");

    const routines = new Map(h.manager.listRoutines().map((routine) => [routine.id, routine]));
    expect(routines.get(roomRoutine.id)).toMatchObject({ enabled: false, nextRunAt: null });
    expect(routines.get(pausedRoomRoutine.id)).toEqual(pausedBefore);
    expect(routines.get(otherRoomRoutine.id)).toMatchObject({ enabled: true, groupId: "room-2" });
    expect(routines.get(botRoutine.id)).toMatchObject({ enabled: true, target: "bot" });

    const runs = new Map(h.manager.listRuns().map((run) => [run.id, run]));
    for (const id of [waitingRun.id, runningRun.id, queuedRun.id]) {
      expect(runs.get(id)).toMatchObject({
        status: "cancelled",
        error: "The assigned room was deleted",
        finishedAt: expect.any(Number),
      });
      expect(runs.get(id)?.attention).toBeUndefined();
    }
    expect(runs.get(otherRoomRun.id)).toMatchObject({ status: "running", groupId: "room-2" });
    expect(runs.get(botRun.id)).toMatchObject({ status: "running", target: "bot" });

    expect(h.interruptedGoals).toEqual([
      { groupId: "room-1", threadId: "goal-thread-1" },
      { groupId: "room-1", threadId: "goal-thread-2" },
    ]);
    expect(h.interruptedTurns).toEqual([]);
    expect(h.changed.map((run) => run.id)).toEqual([waitingRun.id, runningRun.id, queuedRun.id]);
    expect(h.emitted.filter((payload) => payload.kind === "routine").map((payload) => payload.routine.id))
      .toEqual([roomRoutine.id]);
    expect(h.emitted.filter((payload) => payload.kind === "routine.run").map((payload) => payload.run.id))
      .toEqual([waitingRun.id, runningRun.id, queuedRun.id]);
  });

  it("snapshots queued instructions so later edits do not rewrite a receipt", async () => {
    const h = harness();
    h.setBot("busy");
    const routine = h.manager.create({
      name: "Original brief",
      prompt: "Use the original instructions",
      botId: "maus-2",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    h.manager.update(routine.id, { name: "Edited brief", prompt: "Use the new instructions" });

    h.setBot("ready");
    await h.manager.tick();

    expect(h.started[0]?.prompt).toBe("Use the original instructions");
    expect(h.manager.listRuns()[0]).toMatchObject({
      routineName: "Original brief",
      prompt: "Use the original instructions",
    });
  });

  it("snapshots attachment context and deep-clones it across public boundaries", async () => {
    const h = harness();
    h.setBot("busy");
    const routine = h.manager.create({
      name: "Original context",
      prompt: "Use the original attachment",
      botId: "maus-context",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
      attachments: [{
        id: "original",
        kind: "file",
        name: "original.txt",
        path: "/tmp/original.txt",
        size: 12,
      }],
    });
    const emittedRoutine = h.emitted.find((payload) => payload.kind === "routine").routine;
    emittedRoutine.attachments[0].path = "/tmp/tampered-emission.txt";
    expect(h.manager.listRoutines()[0]?.attachments?.[0]?.path).toBe("/tmp/original.txt");
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    h.manager.update(routine.id, {
      attachments: [{
        id: "replacement",
        kind: "file",
        name: "replacement.txt",
        path: "/tmp/replacement.txt",
        size: 24,
      }],
    });

    const publicRun = h.manager.listRuns()[0]!;
    publicRun.attachments![0]!.path = "/tmp/tampered.txt";
    expect(h.manager.listRuns()[0]?.attachments?.[0]?.path).toBe("/tmp/original.txt");

    h.setBot("ready");
    await h.manager.tick();
    expect(h.started[0]?.prompt).toBe(
      'Use the original attachment\n\n<attached-file path="/tmp/original.txt" name="original.txt" />',
    );
    expect(h.manager.listRuns()[0]?.attachments?.[0]?.path).toBe("/tmp/original.txt");
    expect(h.manager.listRoutines()[0]?.attachments?.[0]?.path).toBe("/tmp/replacement.txt");
  });

  it("escapes attachment paths only in the ephemeral dispatch prompt", async () => {
    const h = harness();
    const unusualPath = '/tmp/a"&<>\t\n\r.png';
    const routine = h.manager.create({
      name: "Inspect image",
      prompt: "Inspect it",
      botId: "maus-image",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
      attachments: [{
        id: "image-1",
        kind: "image",
        name: "image.png",
        path: unusualPath,
        size: 128,
      }],
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();

    expect(h.started[0]?.prompt).toBe(
      'Inspect it\n\n<attached-image path="/tmp/a&quot;&amp;&lt;&gt;&#9;&#10;&#13;.png" name="image.png" />',
    );
    expect(h.manager.listRoutines()[0]?.prompt).toBe("Inspect it");
    expect(h.manager.listRoutines()[0]?.attachments?.[0]?.path).toBe(unusualPath);
    expect(h.manager.listRuns()[0]?.prompt).toBe("Inspect it");
  });

  it("rejects local attachment context on cloud routines", () => {
    const h = harness();
    const attachment = {
      id: "file-1",
      kind: "file" as const,
      name: "private.pdf",
      path: "/tmp/private.pdf",
      size: 42,
    };
    expect(() => h.manager.create({
      name: "Cloud review",
      prompt: "Review this",
      botId: "maus-cloud",
      runOn: "cloud",
      schedule: { type: "daily", time: "09:00", weekdays: [1] },
      attachments: [attachment],
    })).toThrow(/only run on this computer/i);

    const local = h.manager.create({
      name: "Local review",
      prompt: "Review this",
      botId: "maus-local",
      runOn: "maus",
      schedule: { type: "daily", time: "09:00", weekdays: [1] },
      attachments: [attachment],
    });
    expect(() => h.manager.update(local.id, { runOn: "cloud" })).toThrow(/cloud file staging/i);
    expect(h.manager.listRoutines()[0]).toMatchObject({ runOn: "maus", attachments: [attachment] });
  });

  it("keeps room goals local and attachment-free", () => {
    const h = harness();
    const base = {
      name: "Team review",
      prompt: "Review this together",
      target: "room-goal" as const,
      botId: "chief-1",
      groupId: "room-1",
      schedule: { type: "daily" as const, time: "09:00", weekdays: [1] },
    };
    expect(() => h.manager.create({ ...base, runOn: "cloud" })).toThrow(/only run on this computer/i);
    expect(() => h.manager.create({
      ...base,
      attachments: [{ id: "brief", kind: "file", name: "brief.txt", path: "/tmp/brief.txt", size: 10 }],
    })).toThrow(/do not support attachments/i);

    const routine = h.manager.create(base);
    expect(() => h.manager.update(routine.id, { groupId: null })).toThrow(/choose a room/i);
    const botRoutine = h.manager.update(routine.id, { target: "bot", groupId: null });
    expect(botRoutine).toMatchObject({ target: "bot", botId: "chief-1" });
    expect(botRoutine?.groupId).toBeUndefined();
  });

  it("rejects malformed or unbounded attachment metadata", () => {
    const h = harness();
    const base = {
      name: "Validate context",
      prompt: "Review this",
      botId: "maus-local",
      schedule: { type: "daily" as const, time: "09:00", weekdays: [1] },
    };
    expect(() => h.manager.create({
      ...base,
      attachments: [{ id: "bad", kind: "file", name: "bad.txt", path: "/tmp/bad.txt", size: -1 }],
    })).toThrow(/valid attachment/i);
    expect(() => h.manager.create({
      ...base,
      attachments: Array.from({ length: 51 }, (_, index) => ({
        id: `file-${index}`,
        kind: "file" as const,
        name: `${index}.txt`,
        path: `/tmp/${index}.txt`,
        size: index,
      })),
    })).toThrow(/no more than 50 attachments/i);
  });

  it("snapshots and dispatches the selected execution machine", async () => {
    const h = harness();
    h.setBot("busy");
    const routine = h.manager.create({
      name: "VM review",
      prompt: "Review the project on the virtual machine",
      botId: "maus-cloud",
      runOn: "cloud",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    h.manager.update(routine.id, { runOn: "maus" });

    h.setBot("ready");
    await h.manager.tick();

    expect(h.runOns).toEqual(["cloud"]);
    expect(h.manager.listRuns()[0]).toMatchObject({ runOn: "cloud" });
    expect(h.manager.listRoutines()[0]).toMatchObject({ runOn: "maus" });
  });

  it("opens webhook jobs in the assigned bot's live chat", async () => {
    const h = harness();
    const receivedAt = new Date(2026, 7, 17, 8, 2).getTime();
    const queued = h.manager.enqueueWebhook({
      webhookId: "hook-1",
      webhookName: "New ticket",
      prompt: "Handle ticket 42",
      botId: "maus-webhook",
      runOn: "cloud",
      deliveryId: "delivery-42",
      receivedAt,
    });
    await h.manager.tick();

    expect(queued).toMatchObject({
      routineId: "hook-1",
      webhookId: "hook-1",
      deliveryId: "delivery-42",
      triggerSource: "webhook",
      scheduledFor: receivedAt,
    });
    expect(queued).not.toHaveProperty("durationMinutes");
    expect(h.started).toEqual([{ botId: "maus-webhook", threadId: "thread-1", prompt: "Handle ticket 42" }]);
    expect(h.runOns).toEqual(["cloud"]);
    expect(h.triggerSources).toEqual(["webhook"]);
    expect(h.taskActivations).toEqual([true]);
  });

  it("folds provider lifecycle events into the calendar receipt", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Ship report",
      prompt: "Write the report",
      botId: "maus-3",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    const base = {
      eventId: "event-1",
      provider: "fake",
      threadId: "thread-1",
      createdAt: new Date(h.manager.listRuns()[0]!.startedAt!).toISOString(),
    };
    const secret = `sk-ant-api03-${"abcdefghijklmnopqrstuvwxyz0123456789"}`;
    h.manager.handleRuntimeEvent({
      ...base,
      type: "request.opened",
      requestType: "question",
      tool: "ask",
      summary: `Choose the two actions before using ${secret}`,
    });
    expect(h.manager.listRuns()[0]).toMatchObject({
      status: "waiting",
      attention: expect.stringContaining("Choose the two actions"),
    });
    expect(h.manager.listRuns()[0]!.attention).not.toContain(secret);
    h.manager.handleRuntimeEvent({ ...base, type: "request.resolved", behavior: "answer", source: "user" });
    expect(h.manager.listRuns()[0]!.attention).toBeUndefined();
    h.manager.handleRuntimeEvent({ ...base, type: "item.completed", itemType: "assistant_text", text: "Report shipped." });
    h.manager.handleRuntimeEvent({ ...base, type: "turn.completed", ok: true, cost: 0.02 });

    expect(h.manager.listRuns()[0]).toMatchObject({
      status: "completed",
      output: "Report shipped.",
      cost: 0.02,
    });
  });

  it("ignores intermediate provider completions until the room goal reports its outcome", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Team report",
      prompt: "Write and review the report",
      target: "room-goal",
      botId: "chief-1",
      groupId: "room-1",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    const run = h.manager.listRuns()[0]!;

    expect(h.manager.handleRuntimeEvent({
      eventId: "private-coordinator-text",
      provider: "fake",
      threadId: "goal-thread-1",
      createdAt: new Date().toISOString(),
      type: "item.completed",
      itemType: "assistant_text",
      text: "private coordinator envelope",
    })).toBeNull();
    const folded = h.manager.handleRuntimeEvent({
      eventId: "coordinator-turn-1",
      provider: "fake",
      threadId: "goal-thread-1",
      createdAt: new Date().toISOString(),
      type: "turn.completed",
      ok: true,
      cost: 0.03,
    });
    expect(folded).toBeNull();
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "running" });
    expect(h.manager.listRuns()[0]?.output).toBeUndefined();
    expect(h.manager.listRuns()[0]?.cost).toBeUndefined();

    expect(h.manager.finishGoalRun(run.id, "completed", "Report reviewed and ready.")).toMatchObject({
      status: "completed",
      output: "Report reviewed and ready.",
    });
  });

  it.each(["needs-input", "paused"] satisfies GroupGoalRunStatus[])(
    "keeps a %s room outcome waiting on the human instead of completing the routine",
    async (status) => {
      const h = harness();
      const routine = h.manager.create({
        name: "Bounded team goal",
        prompt: "Reach a bounded result",
        target: "room-goal",
        botId: "chief-1",
        groupId: "room-1",
        schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
      });
      h.setNow(routine.nextRunAt!);
      await h.manager.tick();
      const run = h.manager.listRuns()[0]!;

      const finished = h.manager.finishGoalRun(run.id, status, `${status} detail`);
      // the team stopped to ask — that is a run waiting on a person, and the
      // one outcome that must never be filed as a quiet completion
      expect(finished).toMatchObject({ status: "waiting", goalStatus: status, attention: `${status} detail` });
      expect(finished?.finishedAt).toBeUndefined();
      expect(h.failed).toEqual([]);
    },
  );

  it.each(["blocked", "limit-reached"] satisfies GroupGoalRunStatus[])(
    "records a %s room outcome as a failed routine run with the goal's own detail",
    async (status) => {
      const h = harness();
      const routine = h.manager.create({
        name: "Bounded team goal",
        prompt: "Reach a bounded result",
        target: "room-goal",
        botId: "chief-1",
        groupId: "room-1",
        schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
      });
      h.setNow(routine.nextRunAt!);
      await h.manager.tick();
      const run = h.manager.listRuns()[0]!;

      const finished = h.manager.finishGoalRun(run.id, status, `${status} detail`);
      expect(finished).toMatchObject({ status: "failed", goalStatus: status, error: `${status} detail` });
      expect(finished?.finishedAt).toBeTypeOf("number");
      expect(h.failed).toHaveLength(1);
    },
  );

  it("maps failed and stopped room outcomes to their routine terminal states", async () => {
    const failedHarness = harness();
    const failedRoutine = failedHarness.manager.create({
      name: "Failing team goal",
      prompt: "Try the work",
      target: "room-goal",
      botId: "chief-1",
      groupId: "room-1",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    failedHarness.setNow(failedRoutine.nextRunAt!);
    await failedHarness.manager.tick();
    const failedRun = failedHarness.manager.listRuns()[0]!;
    expect(failedHarness.manager.finishGoalRun(failedRun.id, "failed", "Coordinator crashed")).toMatchObject({
      status: "failed",
      goalStatus: "failed",
      error: "Coordinator crashed",
    });
    expect(failedHarness.failed).toMatchObject([{ id: failedRun.id, status: "failed" }]);

    const stoppedHarness = harness();
    const stoppedRoutine = stoppedHarness.manager.create({
      name: "Stopped team goal",
      prompt: "Try the work",
      target: "room-goal",
      botId: "chief-1",
      groupId: "room-1",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    stoppedHarness.setNow(stoppedRoutine.nextRunAt!);
    await stoppedHarness.manager.tick();
    const stoppedRun = stoppedHarness.manager.listRuns()[0]!;
    expect(stoppedHarness.manager.finishGoalRun(stoppedRun.id, "stopped", "Stopped by you.")).toMatchObject({
      status: "cancelled",
      goalStatus: "stopped",
    });
    expect(stoppedHarness.failed).toEqual([]);
  });

  it("cancels a running room goal through the room orchestrator", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Cancelable team goal",
      prompt: "Work until stopped",
      target: "room-goal",
      botId: "chief-1",
      groupId: "room-1",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    const run = h.manager.listRuns()[0]!;

    expect(await h.manager.cancelRun(run.id)).toMatchObject({ status: "cancelled", goalStatus: "stopped" });
    expect(h.interruptedGoals).toEqual([{ groupId: "room-1", threadId: "goal-thread-1" }]);
    expect(h.interruptedTurns).toEqual([]);
    expect(h.manager.finishGoalRun(run.id, "stopped", "Stopped by you.")).toBeNull();
  });

  it("reports a failed run once with its detached thread", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Broken report",
      prompt: "Write the report",
      botId: "maus-failed",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();

    h.manager.handleRuntimeEvent({
      eventId: "failed",
      provider: "fake",
      threadId: "thread-1",
      createdAt: new Date().toISOString(),
      type: "turn.completed",
      ok: false,
      stopReason: "provider crashed",
    });

    expect(h.failed).toMatchObject([
      {
        routineName: "Broken report",
        botId: "maus-failed",
        threadId: "thread-1",
        status: "failed",
        error: "provider crashed",
      },
    ]);
    expect(h.manager.listRuns()[0]).toMatchObject({ threadId: "thread-1", status: "failed" });

    h.manager.markSeen(h.failed[0].id);
    expect(h.failed).toHaveLength(1);
  });

  it("keeps recurring history while advancing the definition", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Daily check",
      prompt: "Check it",
      botId: "maus-4",
      schedule: { type: "daily", time: "08:05", weekdays: [1, 2, 3, 4, 5] },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    h.manager.handleRuntimeEvent({
      eventId: "done",
      provider: "fake",
      threadId: "thread-1",
      createdAt: new Date().toISOString(),
      type: "turn.completed",
      ok: true,
    });

    expect(h.manager.listRuns()).toHaveLength(1);
    expect(h.manager.listRoutines()[0]!.nextRunAt).toBeGreaterThan(routine.nextRunAt!);
  });

  it("records a missed receipt instead of launching very stale work", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Old check",
      prompt: "Do the old thing",
      botId: "maus-5",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    h.setNow(routine.nextRunAt! + 13 * 60 * 60_000);
    await h.manager.tick();
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "missed" });
    expect(h.started).toHaveLength(0);
    expect(h.failed).toMatchObject([{ id: h.manager.listRuns()[0]!.id, status: "missed" }]);
  });

  it("records a missed receipt for a once routine created with a long-past time", async () => {
    const h = harness();
    const staleAt = new Date(2026, 7, 16, 6, 0, 0).getTime();
    const routine = h.manager.create({
      name: "Stale check",
      prompt: "Do the stale thing",
      botId: "maus-6",
      schedule: { type: "once", at: staleAt },
    });
    expect(routine.nextRunAt).toBe(staleAt);
    await h.manager.tick();
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "missed", scheduledFor: staleAt });
    expect(h.started).toHaveLength(0);
  });

  it("runs a once routine created slightly late and records the original scheduled time", async () => {
    const h = harness();
    const lateAt = new Date(2026, 7, 17, 7, 55, 0).getTime();
    const routine = h.manager.create({
      name: "Late check",
      prompt: "Do the late thing",
      botId: "maus-7",
      schedule: { type: "once", at: lateAt },
    });
    expect(routine.nextRunAt).toBe(lateAt);
    await h.manager.tick();
    expect(h.started).toHaveLength(1);
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "running", scheduledFor: lateAt });
  });
});
