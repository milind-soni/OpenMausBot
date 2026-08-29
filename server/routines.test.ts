import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createChangeMarkerPreflight, nextOccurrence, RoutineManager, type RoutineManagerOptions } from "./routines.ts";

const dirs: string[] = [];

function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), "omb-routines-"));
  dirs.push(dir);
  return join(dir, "routines.json");
}

function harness(start = new Date(2026, 7, 17, 8, 0, 0).getTime()) {
  let now = start;
  let bot: "ready" | "busy" | "missing" = "ready";
  let task = 0;
  const started: Array<{ botId: string; threadId: string; prompt: string }> = [];
  const runOns: string[] = [];
  const triggerSources: string[] = [];
  const capabilityPolicies: unknown[] = [];
  const taskActivations: boolean[] = [];
  const emitted: any[] = [];
  const failed: any[] = [];
  const options: RoutineManagerOptions = {
    file: tempFile(),
    now: () => now,
    emit: (payload) => emitted.push(payload),
    botState: () => bot,
    createTask: (_botId, _title, activate = false) => {
      taskActivations.push(activate);
      return { threadId: `thread-${++task}` };
    },
    startTurn: async (botId, threadId, prompt, runOn, triggerSource, capabilities) => {
      started.push({ botId, threadId, prompt });
      runOns.push(runOn);
      triggerSources.push(triggerSource);
      capabilityPolicies.push(capabilities);
    },
    onRunFailed: (run) => failed.push(run),
  };
  const manager = new RoutineManager(options);
  return {
    manager,
    options,
    emitted,
    started,
    runOns,
    triggerSources,
    capabilityPolicies,
    taskActivations,
    failed,
    setNow: (value: number) => (now = value),
    setBot: (value: typeof bot) => (bot = value),
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

  it("finds interval slots inside a weekday window", () => {
    const monday = new Date(2026, 7, 17, 8, 2, 0).getTime();
    const schedule = {
      type: "interval",
      everyMinutes: 5,
      from: "08:00",
      to: "19:55",
      weekdays: [1, 2, 3, 4, 5],
    } satisfies Parameters<typeof nextOccurrence>[0];
    expect(nextOccurrence(schedule, monday)).toBe(new Date(2026, 7, 17, 8, 5, 0).getTime());
    expect(nextOccurrence(schedule, new Date(2026, 7, 17, 19, 55, 0).getTime())).toBe(
      new Date(2026, 7, 18, 8, 0, 0).getTime(),
    );
  });

  it("anchors hourly intervals at the configured minute", () => {
    const schedule = {
      type: "interval",
      everyMinutes: 60,
      from: "06:45",
      to: "19:45",
      weekdays: [1, 2, 3, 4, 5],
    } satisfies Parameters<typeof nextOccurrence>[0];
    expect(nextOccurrence(schedule, new Date(2026, 7, 17, 7, 0, 0).getTime())).toBe(
      new Date(2026, 7, 17, 7, 45, 0).getTime(),
    );
  });
});

describe("RoutineManager", () => {
  it("can disable only legacy capture polling after a replacement activates", () => {
    const h = harness();
    const polling = h.manager.create({
      name: "Inbound action watch",
      prompt: "Poll source markers",
      botId: "maus-1",
      schedule: { type: "interval", everyMinutes: 5, from: "08:00", to: "19:55", weekdays: [1, 2, 3, 4, 5] },
      prefilter: { type: "change-marker", sourceIds: ["gmail"] },
    });
    const semantic = h.manager.create({
      name: "Morning full capture",
      prompt: "Run the full morning capture",
      botId: "maus-1",
      schedule: { type: "daily", time: "06:45", weekdays: [1, 2, 3, 4, 5] },
    });

    expect(h.manager.disableMatching((routine) => (
      routine.botId === "maus-1"
      && routine.schedule.type === "interval"
      && routine.prefilter?.type === "change-marker"
    ))).toBe(1);
    expect(h.manager.listRoutines().find((routine) => routine.id === polling.id)).toMatchObject({ enabled: false, nextRunAt: null });
    expect(h.manager.listRoutines().find((routine) => routine.id === semantic.id)).toMatchObject({ enabled: true });
  });

  it("cancels only routines linked to a closed work lock", async () => {
    const h = harness();
    const interrupted: string[] = [];
    h.options.interruptTurn = async (_botId, threadId) => { interrupted.push(threadId); };
    const linked = h.manager.create({
      name: "Gift guard",
      prompt: "Check whether the gift still needs attention",
      botId: "maus-1",
      schedule: { type: "daily", time: "09:00", weekdays: [1] },
      workLockId: "lock-gift",
    });
    const unrelated = h.manager.create({
      name: "Daily brief",
      prompt: "Prepare the daily brief",
      botId: "maus-1",
      schedule: { type: "daily", time: "10:00", weekdays: [1] },
      workLockId: "lock-brief",
    });
    h.manager.runNow(linked.id);
    await h.manager.tick();

    expect(h.manager.cancelForWorkLock("lock-gift", "Gift already bought")).toBe(true);
    expect(h.manager.listRoutines().find((routine) => routine.id === linked.id)).toMatchObject({ enabled: false, nextRunAt: null });
    expect(h.manager.listRoutines().find((routine) => routine.id === unrelated.id)?.enabled).toBe(true);
    expect(h.manager.listRuns().find((run) => run.routineId === linked.id)).toMatchObject({ status: "cancelled", error: "Gift already bought" });
    expect(interrupted).toEqual(["thread-1"]);
  });

  it("enforces scheduled-run budgets while allowing deliberate manual runs", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Budgeted poll",
      prompt: "Check for changes",
      botId: "maus-1",
      schedule: { type: "interval", everyMinutes: 5, from: "08:00", to: "09:00", weekdays: [1] },
      budget: { maxScheduledRunsPerDay: 1 },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    h.manager.handleRuntimeEvent({
      type: "turn.completed",
      eventId: "event-1",
      provider: "cursorAgent",
      threadId: "thread-1",
      createdAt: new Date().toISOString(),
      ok: true,
      usage: { input: 10, output: 5 },
    });
    const next = h.manager.listRoutines()[0]?.nextRunAt;
    if (next === null || next === undefined) throw new Error("interval routine lost its next run");
    h.setNow(next);
    await h.manager.tick();
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "skipped", error: "Daily scheduled-run budget reached (1)" });

    h.manager.runNow(routine.id);
    await h.manager.tick();
    expect(h.started).toHaveLength(2);
  });

  it("clears a removed budget when an update supplies the explicit empty shape", () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Budget migration",
      prompt: "Check for changes",
      botId: "maus-1",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
      budget: { maxCostUsdPerDay: 5 },
    });
    const updated = h.manager.update(routine.id, { budget: {} });
    expect(updated?.budget).toBeUndefined();
  });

  it("fails and interrupts an overlong run", async () => {
    const h = harness();
    const interrupted: string[] = [];
    h.options.interruptTurn = async (_botId, threadId) => { interrupted.push(threadId); };
    const routine = h.manager.create({
      name: "Bounded task",
      prompt: "Finish promptly",
      botId: "maus-1",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
      durationMinutes: 15,
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    h.setNow(routine.nextRunAt! + 15 * 60_000 + 1);
    await h.manager.tick();
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "blocked", error: "Routine exceeded its 15-minute runtime limit" });
    expect(interrupted).toEqual(["thread-1"]);
  });

  it("uses a deterministic preflight only for scheduled work and fails open on errors", async () => {
    const h = harness();
    h.options.preflight = async () => ({ kind: "skip", reason: "No source marker changed" });
    const routine = h.manager.create({
      name: "Quiet poll",
      prompt: "Check inboxes",
      botId: "maus-1",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
      prefilter: { type: "change-marker", sourceIds: ["gmail", "calendar"] },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "skipped", error: "No source marker changed" });
    expect(h.started).toHaveLength(0);
  });

  it("skips unchanged scheduled source markers, then runs after a marker changes", async () => {
    const h = harness();
    let marker = "first";
    h.options.preflight = createChangeMarkerPreflight(async (_botId, sourceIds) =>
      sourceIds.map((sourceId) => ({ sourceId, marker, ready: true })));
    const routine = h.manager.create({
      name: "Marker watch",
      prompt: "Read only when a source changes",
      botId: "capture",
      schedule: { type: "interval", everyMinutes: 5, from: "08:00", to: "09:00", weekdays: [1] },
      prefilter: { type: "change-marker", sourceIds: ["gmail", "messages"] },
    });

    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    expect(h.started).toHaveLength(1);
    h.manager.handleRuntimeEvent({
      eventId: "marker-1",
      provider: "fake",
      threadId: "thread-1",
      createdAt: new Date().toISOString(),
      type: "turn.completed",
      ok: true,
    });

    const secondSlot = h.manager.listRoutines()[0]!.nextRunAt!;
    h.setNow(secondSlot);
    await h.manager.tick();
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "skipped", error: "No source marker changed" });
    expect(h.started).toHaveLength(1);

    marker = "changed";
    const thirdSlot = h.manager.listRoutines()[0]!.nextRunAt!;
    h.setNow(thirdSlot);
    await h.manager.tick();
    expect(h.started).toHaveLength(2);
  });

  it("fails open when a source marker is unknown, stale, auth-blocked, or failed", async () => {
    const h = harness();
    h.options.preflight = createChangeMarkerPreflight(async (_botId, sourceIds) =>
      sourceIds.map((sourceId) => ({ sourceId, marker: null, ready: false })));
    const routine = h.manager.create({
      name: "Unavailable marker watch",
      prompt: "Run when marker evidence is unavailable",
      botId: "capture",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
      prefilter: { type: "change-marker", sourceIds: ["gmail"] },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    expect(h.started).toHaveLength(1);
    expect(h.manager.listRuns()[0]?.status).toBe("running");
  });

  it("persists definitions separately from permanent run receipts", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Morning brief",
      prompt: "Summarize what changed",
      botId: "maus-1",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 5).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();

    const routineFile = h.options.file;
    if (!routineFile) throw new Error("test harness did not configure routine persistence");
    let failureWasPersistedBeforeCallback = false;
    h.options.onRunFailed = (run) => {
      h.failed.push(run);
      failureWasPersistedBeforeCallback = readFileSync(routineFile, "utf8").includes('"status": "blocked"');
    };
    const reloaded = new RoutineManager(h.options);
    expect(reloaded.listRoutines()).toHaveLength(1);
    expect(reloaded.listRuns()).toMatchObject([
      { routineId: routine.id, routineName: "Morning brief", status: "blocked", threadId: "thread-1" },
    ]);
    // Reload recovery truthfully marks an in-process run as interrupted.
    expect(reloaded.listRuns()[0]!.error).toContain("restarted");
    expect(failureWasPersistedBeforeCallback).toBe(true);
    expect(h.failed).toMatchObject([
      {
        routineId: routine.id,
        routineName: "Morning brief",
        status: "blocked",
        threadId: "thread-1",
        error: "OpenMausBot restarted while this routine was running",
      },
    ]);
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
    expect(h.started).toHaveLength(1);
    expect(h.started[0]).toMatchObject({ botId: "maus-2", threadId: "thread-1" });
    expect(h.started[0]?.prompt).toContain("Review the queue");
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "running", threadId: "thread-1" });
    expect(h.manager.activeRunForBot("maus-2")?.threadId).toBe("thread-1");
    expect(h.manager.isActiveThread("thread-1")).toBe(true);
    expect(h.taskActivations).toEqual([false]);
  });

  it("keeps one scheduled turn per bot active even when provider busy state lags", async () => {
    const h = harness();
    const at = new Date(2026, 7, 17, 8, 1).getTime();
    h.manager.create({ name: "First", prompt: "First job", botId: "capture", schedule: { type: "once", at } });
    h.manager.create({ name: "Second", prompt: "Second job", botId: "capture", schedule: { type: "once", at } });
    h.setNow(at);
    await h.manager.tick();
    expect(h.started).toHaveLength(1);
    expect(h.manager.listRuns().filter((run) => run.status === "running")).toHaveLength(1);
    expect(h.manager.listRuns().filter((run) => run.status === "queued")).toHaveLength(1);

    h.manager.handleRuntimeEvent({
      eventId: "first-done",
      provider: "fake",
      threadId: "thread-1",
      createdAt: new Date().toISOString(),
      type: "turn.completed",
      ok: true,
    });
    await h.manager.tick();
    expect(h.started).toHaveLength(2);
    expect(h.manager.listRuns().filter((run) => run.status === "running")).toHaveLength(1);
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

    expect(h.started[0]?.prompt).toContain("Use the original instructions");
    expect(h.manager.listRuns()[0]).toMatchObject({
      routineName: "Original brief",
      prompt: "Use the original instructions",
    });
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
    expect(h.started).toHaveLength(1);
    expect(h.started[0]).toMatchObject({ botId: "maus-webhook", threadId: "thread-1" });
    expect(h.started[0]?.prompt).toContain("Handle ticket 42");
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
    h.manager.handleRuntimeEvent({ ...base, type: "request.opened", requestType: "question", tool: "ask", summary: "Need a date" });
    expect(h.manager.listRuns()[0]!.status).toBe("waiting");
    h.manager.handleRuntimeEvent({ ...base, type: "request.resolved", behavior: "answer", source: "user" });
    h.manager.handleRuntimeEvent({ ...base, type: "item.completed", itemType: "assistant_text", text: "Report shipped." });
    h.manager.handleRuntimeEvent({ ...base, type: "turn.completed", ok: true, cost: 0.02 });

    expect(h.manager.listRuns()[0]).toMatchObject({
      status: "completed",
      output: "Report shipped.",
      cost: 0.02,
    });
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

  it("coalesces interval slots into one queued catch-up run", async () => {
    const h = harness();
    h.setBot("busy");
    const routine = h.manager.create({
      name: "Inbound watch",
      prompt: "Collect from durable cursors",
      botId: "capture",
      schedule: { type: "interval", everyMinutes: 5, from: "08:00", to: "19:55", weekdays: [1, 2, 3, 4, 5] },
    });
    const first = routine.nextRunAt!;
    h.setNow(first);
    await h.manager.tick();
    h.setNow(first + 5 * 60_000);
    await h.manager.tick();
    h.setNow(first + 10 * 60_000);
    await h.manager.tick();

    expect(h.manager.listRuns()).toHaveLength(1);
    expect(h.manager.listRuns()[0]).toMatchObject({
      scheduledFor: first,
      coalescedThrough: first + 10 * 60_000,
      coalescedCount: 2,
      status: "queued",
    });

    h.setBot("ready");
    await h.manager.tick();
    expect(h.started[0]?.prompt).toContain("Additional due slots: 2");
    expect(h.started[0]?.prompt).toContain("Collect from durable cursors");
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
  });

  it("marks a successful task verified only after concrete evidence is recorded", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Verified build",
      prompt: "Build and test it",
      botId: "builder",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    expect(h.manager.recordEvidence("builder", "thread-1", {
      kind: "test",
      summary: "Release test suite passed 42/42",
      reference: "artifact://test-report/42",
    })?.evidence).toHaveLength(1);
    h.manager.handleRuntimeEvent({
      eventId: "verified",
      provider: "fake",
      threadId: "thread-1",
      createdAt: new Date().toISOString(),
      type: "turn.completed",
      ok: true,
    });
    expect(h.manager.listRuns()[0]).toMatchObject({
      status: "verified",
      evidence: [{ kind: "test", summary: "Release test suite passed 42/42" }],
    });
  });

  it("permits one durable retry only when its strategy materially changes", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Recoverable task",
      prompt: "Fetch the report",
      botId: "operator",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
      maxChangedStrategyRetries: 1,
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
      stopReason: "browser selector failed",
    });
    const failed = h.manager.listRuns()[0]!;
    expect(() => h.manager.retryRun(failed.id, "short")).toThrow(/materially different/i);
    const retry = h.manager.retryRun(failed.id, "Use the semantic browser snapshot instead of pixel coordinates");
    expect(retry).toMatchObject({ status: "queued", retryOf: failed.id, retryCount: 1 });
    await h.manager.tick();
    h.manager.handleRuntimeEvent({
      eventId: "failed-again",
      provider: "fake",
      threadId: "thread-2",
      createdAt: new Date().toISOString(),
      type: "turn.completed",
      ok: false,
      stopReason: "authentication required",
    });
    expect(() => h.manager.retryRun(retry.id, "Ask for a fresh authenticated session and resume")).toThrow(/no changed-strategy retry/i);
  });

  it("snapshots restrictive task capabilities into the run and dispatch", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Read-only review",
      prompt: "Inspect without acting",
      botId: "reviewer",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
      capabilities: { connectedApps: "read-only", computer: "off", peerBots: "off", phone: "off" },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    expect(h.capabilityPolicies).toEqual([
      { connectedApps: "read-only", computer: "off", peerBots: "off", phone: "off" },
    ]);
    expect(h.manager.listRuns()[0]?.capabilities).toEqual(h.capabilityPolicies[0]);
  });
});
