import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { recoverRun } from "./routine-recovery.ts";
import { RoutineManager, type RoutineRun } from "./routines.ts";

const START = new Date(2026, 9, 19, 9, 0, 0).getTime();
const HOUR = 3_600_000;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "omb-limit-routines-"));
  dirs.push(dir);
  let now = START;
  const resets = new Map<string, number | null>();
  const started: Array<{ threadId: string; prompt: string }> = [];
  const emitted: any[] = [];
  let task = 0;
  const options = {
    file: join(dir, "routines.json"),
    now: () => now,
    emit: (payload: Record<string, unknown>) => emitted.push(payload),
    botState: () => "ready" as const,
    createTask: () => ({ threadId: `thread-${++task}` }),
    joinConversation: (run: RoutineRun) => run.sourceThreadId ?? null,
    startTurn: async (_botId: string, threadId: string, prompt: string) => { started.push({ threadId, prompt }); },
    limitResetAt: (engine: string) => resets.get(engine) ?? null,
  };
  const manager = new RoutineManager(options);
  return {
    manager, started, emitted, options,
    at: (next: number) => { now = next; },
    reset: (engine: string, at: number | null) => resets.set(engine, at),
    create: (repeat: "once" | "every_reset" = "once", extra: Record<string, unknown> = {}) => manager.create({
      name: "Finish the report", prompt: "Finish the report.", botId: "scout", schedule: { type: "limit_reset", engine: "claude", repeat }, ...extra,
    }),
  };
}

describe("limit-reset routines", () => {
  it("run a minute after the engine's reset, and wait with no time while the reset is unknown", async () => {
    const h = harness();
    h.reset("claude", START + 2 * HOUR);
    const known = h.create();
    expect(known.schedule).toEqual({ type: "limit_reset", engine: "claude", repeat: "once", at: START + 2 * HOUR + 60_000 });
    expect(known.nextRunAt).toBe(START + 2 * HOUR + 60_000);
    h.reset("codex", null);
    const unknown = h.manager.create({ name: "Later", prompt: "Do the rest.", botId: "scout", schedule: { type: "limit_reset", engine: "codex" } });
    expect(unknown.schedule).toMatchObject({ engine: "codex", repeat: "once", at: null });
    expect(unknown.nextRunAt).toBeNull();
    await h.manager.tick();
    expect(h.started).toEqual([]);
  });

  it("never takes its time from input", () => {
    const h = harness();
    h.reset("claude", START + HOUR);
    const routine = h.manager.create({ name: "x", prompt: "y", botId: "scout", schedule: { type: "limit_reset", engine: "claude", at: START + 1 } });
    expect(routine.nextRunAt).toBe(START + HOUR + 60_000);
  });

  it("moves its run when the reset moves, and picks up a time once one is known", () => {
    const h = harness();
    h.reset("claude", null);
    const routine = h.create();
    h.reset("claude", START + 3 * HOUR);
    expect(h.manager.retimeLimitResets()).toBe(1);
    expect(h.manager.listRoutines()[0]!.nextRunAt).toBe(START + 3 * HOUR + 60_000);
    expect(h.emitted.filter((frame) => frame.kind === "routine" && frame.routine.id === routine.id).at(-1).routine.nextRunAt).toBe(START + 3 * HOUR + 60_000);
    h.reset("claude", START + 4 * HOUR);
    h.manager.retimeLimitResets();
    expect(h.manager.listRoutines()[0]!.schedule).toMatchObject({ at: START + 4 * HOUR + 60_000 });
    expect(h.manager.retimeLimitResets()).toBe(0);
  });

  it("runs once in the conversation it came from, then is done", async () => {
    const h = harness();
    h.reset("claude", START + HOUR);
    h.manager.create({ name: "Continue", prompt: "Continue where it stopped.", botId: "scout", schedule: { type: "limit_reset", engine: "claude" } },
      { requestId: "r1", messageId: "m1", botId: "scout", threadId: "talk-1", action: "create", fingerprintVersion: 1, fingerprint: "a".repeat(64) });
    h.at(START + HOUR + 59_000);
    await h.manager.tick();
    expect(h.started).toEqual([]);
    h.at(START + HOUR + 61_000);
    await h.manager.tick();
    expect(h.started).toHaveLength(1);
    expect(h.started[0]!.threadId).toBe("talk-1");
    expect(h.started[0]!.prompt).toContain("Continue where it stopped.");
    const routine = h.manager.listRoutines()[0]!;
    expect(routine).toMatchObject({ enabled: false, nextRunAt: null });
    h.reset("claude", START + 6 * HOUR);
    expect(h.manager.retimeLimitResets()).toBe(0);
  });

  it("every reset: runs again only for a later reset, never twice for the same one", async () => {
    const h = harness();
    h.reset("claude", START + HOUR);
    h.create("every_reset");
    h.at(START + HOUR + 2 * 60_000);
    await h.manager.tick();
    expect(h.started).toHaveLength(1);
    h.manager.handleRuntimeEvent({ type: "turn.completed", threadId: "thread-1", ok: true } as never);
    let routine = h.manager.listRoutines()[0]!;
    expect(routine).toMatchObject({ enabled: true, nextRunAt: null });
    h.manager.retimeLimitResets();
    await h.manager.tick();
    expect(h.started).toHaveLength(1);
    h.reset("claude", START + 6 * HOUR);
    h.manager.retimeLimitResets();
    routine = h.manager.listRoutines()[0]!;
    expect(routine.nextRunAt).toBe(START + 6 * HOUR + 60_000);
    h.at(START + 6 * HOUR + 2 * 60_000);
    await h.manager.tick();
    expect(h.started).toHaveLength(2);
  });

  it("still runs when the computer wakes long after the reset, which a fixed time would call missed", async () => {
    const h = harness();
    h.reset("claude", START + HOUR);
    h.create();
    h.at(START + 20 * HOUR);
    await h.manager.tick();
    expect(h.started).toHaveLength(1);
    expect(h.manager.listRuns()[0]!.status).toBe("running");
  });

  it("does not also run at startup when it runs once", () => {
    const h = harness();
    expect(h.create("once", { runOnStartup: true }).runOnStartup).toBeUndefined();
    expect(h.create("every_reset", { runOnStartup: true, prompt: "Other." }).runOnStartup).toBe(true);
  });

  it("survives a restart with its engine and repeat", () => {
    const h = harness();
    h.reset("claude", START + HOUR);
    h.create("every_reset");
    const again = new RoutineManager(h.options);
    expect(again.listRoutines()[0]!.schedule).toEqual({ type: "limit_reset", engine: "claude", repeat: "every_reset", at: START + HOUR + 60_000 });
  });

  it("refuses an engine id that is not one", () => {
    const h = harness();
    expect(() => h.manager.create({ name: "x", prompt: "y", botId: "scout", schedule: { type: "limit_reset", engine: "../etc" } })).toThrow(/which AI/);
  });
});

describe("Move to after reset", () => {
  it("moves only the next run of a repeating schedule; the ones after keep their time", async () => {
    const h = harness();
    const daily = h.manager.create({ name: "Brief", prompt: "Brief me.", botId: "scout", schedule: { type: "daily", time: "10:00", weekdays: [0, 1, 2, 3, 4, 5, 6] } });
    expect(daily.nextRunAt).toBe(START + HOUR);
    const until = START + 3 * HOUR;
    expect(h.manager.deferNextRun(daily.id, until)!.nextRunAt).toBe(until);
    h.at(START + HOUR + 60_000);
    await h.manager.tick();
    expect(h.started).toHaveLength(0);
    h.at(until + 1_000);
    await h.manager.tick();
    expect(h.started).toHaveLength(1);
    expect(h.manager.listRoutines()[0]!.nextRunAt).toBe(START + 25 * HOUR);
  });

  it("moves a one-time schedule's time, and leaves a run already after the reset alone", () => {
    const h = harness();
    const once = h.manager.create({ name: "Once", prompt: "Do it.", botId: "scout", schedule: { type: "once", at: START + HOUR } });
    expect(h.manager.deferNextRun(once.id, START + 2 * HOUR)!.schedule).toEqual({ type: "once", at: START + 2 * HOUR });
    expect(h.manager.deferNextRun(once.id, START + HOUR)!.nextRunAt).toBe(START + 2 * HOUR);
    expect(h.manager.deferNextRun("missing", START)).toBeNull();
  });
});

describe("a usage limit with a backup engine", () => {
  const run = (): RoutineRun => ({ id: "run-1", routineId: "r", routineName: "Brief", target: "bot", botId: "scout", runOn: "maus", scheduledFor: START,
    status: "running", manual: false, createdAt: START, threadId: "t" });

  it("starts the run again at once, for the backup to take, instead of waiting for the reset", () => {
    const waiting = run();
    expect(recoverRun(waiting, "This Claude account has reached its 5-hour limit", { limitResetsAt: START + 2 * HOUR }, START, [])).toMatchObject({ queued: true });
    expect(waiting.retryAt).toBe(START + 2 * HOUR + 60_000);
    const backup = run();
    expect(recoverRun(backup, "This Claude account has reached its 5-hour limit", { limitResetsAt: START + 2 * HOUR, backupReady: true }, START, [])).toEqual({ queued: true });
    expect(backup.retryAt).toBe(START + 15_000);
    expect(backup.attention).toMatch(/backup AI/);
  });
});
