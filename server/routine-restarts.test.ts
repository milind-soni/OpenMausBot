// A headless server that crashes and starts again in a loop: what its routines start, counted in turns (each is at least
// one request to the AI).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ROUTINE_RETRY_MS } from "./routine-recovery.ts";
import { restartRetryAt, ROUTINE_RESTART_STAGGER_MS, STARTUP_ROUTINE_GAP_MS, startupDecision, startupRoutineGapMs } from "./routine-restarts.ts";
import { RoutineManager, type RoutineManagerOptions } from "./routines.ts";

const MINUTE = 60_000, HOUR = 60 * MINUTE;
const START = Date.parse("2026-11-16T08:00:00Z");
const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function server(launchId?: () => string) {
  const dir = mkdtempSync(join(tmpdir(), "omb-routine-restarts-"));
  dirs.push(dir);
  let now = START, task = 0;
  const started: Array<{ threadId: string; trigger: string }> = [];
  const options = (): RoutineManagerOptions => ({
    file: join(dir, "routines.json"), now: () => now, botState: () => "ready", launchId: launchId?.(),
    createTask: () => ({ threadId: `thread-${++task}` }),
    startTurn: async (_botId, threadId, _prompt, _runOn, trigger) => { started.push({ threadId, trigger }); },
  });
  const first = new RoutineManager(options());
  return {
    started, first,
    setNow: (at: number) => { now = at; },
    /** One process start: its scheduler's first pass, then each turn it started ends before the process dies. */
    async boot(): Promise<RoutineManager> {
      const booted = new RoutineManager(options());
      booted.start();
      await booted.tick();
      for (const run of booted.listRuns().filter((candidate) => candidate.status === "running")) {
        booted.handleRuntimeEvent({ eventId: `done-${run.id}`, provider: "fake", threadId: run.threadId!, createdAt: new Date(now).toISOString(), type: "turn.completed", ok: true });
      }
      booted.close();
      return booted;
    },
  };
}

const daily = { name: "Morning brief", prompt: "Brief me", botId: "maus-1", runOnStartup: true, schedule: { type: "daily" as const, time: "23:00", weekdays: [0, 1, 2, 3, 4, 5, 6] } };

describe("a headless server's startup routines", () => {
  it("run at most once in OMB_STARTUP_ROUTINE_GAP_MS while the server crashes and starts again every minute", async () => {
    const s = server();
    const routine = s.first.create(daily);
    let last: RoutineManager | undefined;
    for (let minute = 0; minute < 60; minute++) {
      s.setNow(START + minute * MINUTE);
      last = await s.boot();
    }
    const startups = s.started.filter((turn) => turn.trigger === "startup");
    console.log(`startup turns in an hour of restarts every minute: ${startups.length}`);
    expect(startups).toHaveLength(2);
    const skipped = last!.listRuns().filter((run) => run.status === "missed");
    expect(skipped.map((run) => [run.routineId, run.triggerSource, run.skipped?.count, run.error])).toEqual([
      [routine.id, "startup", 29, "Not run at 29 starts because OpenMausBot started again soon after the start that last ran it"],
      [routine.id, "startup", 29, "Not run at 29 starts because OpenMausBot started again soon after the start that last ran it"],
    ]);
  });

  it("run at every start with OMB_STARTUP_ROUTINE_GAP_MS=0", async () => {
    vi.stubEnv("OMB_STARTUP_ROUTINE_GAP_MS", "0");
    const s = server();
    s.first.create(daily);
    for (let minute = 0; minute < 10; minute++) {
      s.setNow(START + minute * MINUTE);
      await s.boot();
    }
    expect(s.started.filter((turn) => turn.trigger === "startup")).toHaveLength(10);
  });

  it("still run once per desktop launch, whatever the gap", async () => {
    let launch = 0;
    const s = server(() => `launch-${++launch}`);
    s.first.create(daily);
    for (let minute = 0; minute < 3; minute++) {
      s.setNow(START + minute * MINUTE);
      await s.boot();
    }
    expect(s.started.filter((turn) => turn.trigger === "startup")).toHaveLength(3);
  });

  it("decide from what the last start recorded", () => {
    expect(startupDecision("launch-a", "at:1", START)).toEqual({ run: true, marker: "launch-a" });
    expect(startupDecision(undefined, undefined, START)).toEqual({ run: true, marker: `at:${START}` });
    expect(startupDecision(undefined, "launch-a", START)).toEqual({ run: true, marker: `at:${START}` });
    const held = startupDecision(undefined, `at:${START}`, START + STARTUP_ROUTINE_GAP_MS - 1);
    expect(held.run === false && held.behind("r1")).toBe(`startup:${START}:r1`);
    expect(startupDecision(undefined, `at:${START}`, START + STARTUP_ROUTINE_GAP_MS)).toEqual({ run: true, marker: `at:${START + STARTUP_ROUTINE_GAP_MS}` });
    // A clock set back runs them rather than holding them for good.
    expect(startupDecision(undefined, `at:${START}`, START - HOUR)).toMatchObject({ run: true });
    expect(startupRoutineGapMs({ OMB_STARTUP_ROUTINE_GAP_MS: "60000" })).toBe(MINUTE);
    expect(startupRoutineGapMs({ OMB_STARTUP_ROUTINE_GAP_MS: "30m" })).toBe(STARTUP_ROUTINE_GAP_MS);
  });
});

describe("runs a restart cut off", () => {
  it("start again one after another, OMB_ROUTINE_RESTART_STAGGER_MS apart, not all at once", async () => {
    const s = server();
    for (let i = 0; i < 4; i++) s.first.runNow(s.first.create({ ...daily, name: `Brief ${i}`, runOnStartup: false }).id);
    await s.first.tick();
    expect(s.first.listRuns().filter((run) => run.status === "running")).toHaveLength(4);
    s.first.close();
    s.setNow(START + MINUTE);
    const restarted = new RoutineManager({ file: join(dirs[0]!, "routines.json"), now: () => START + MINUTE, botState: () => "ready", createTask: () => ({ threadId: "x" }), startTurn: async () => {} });
    const at = restarted.listRuns().map((run) => [run.status, run.retried, run.retryAt]).sort((a, b) => Number(a[2]) - Number(b[2]));
    expect(at).toEqual([0, 1, 2, 3].map((i) => ["queued", "restarted", START + MINUTE + ROUTINE_RETRY_MS + i * ROUTINE_RESTART_STAGGER_MS]));
    restarted.close();
  });

  it("wait for another machine's lease when that is later", () => {
    expect(restartRetryAt(START, 0, undefined)).toBe(START + ROUTINE_RETRY_MS);
    expect(restartRetryAt(START, 2, START + HOUR)).toBe(START + HOUR);
    expect(restartRetryAt(START, 2, undefined, 0)).toBe(START + ROUTINE_RETRY_MS);
  });
});
