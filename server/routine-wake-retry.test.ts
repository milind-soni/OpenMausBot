import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RUN_COMPUTER_LINES } from "../shared/cloud-computer-recovery.ts";
import { CATCH_UP_MS } from "./routine-catch-up.ts";
import { WAKE_RETRY_AFTER_MS, WAKE_RETRY_LAST_MS, waitsToWakeAgain, wakeRetry } from "./routine-wake-retry.ts";
import type { RoutineScheduleInput } from "./routine-schedules.ts";
import { RoutineManager, type RoutineManagerOptions } from "./routines.ts";

const MINUTE = 60_000;
const START = new Date(2026, 10, 18, 8, 0, 0).getTime();
const dirs: string[] = [];
const managers: RoutineManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A cloud bot's routine whose computer answers each wake from `wakes`, in order: a reason it did not start, or null. */
function harness(wakes: Array<string | null | "hang">, everyMinutes = 60, schedule?: RoutineScheduleInput) {
  const dir = mkdtempSync(join(tmpdir(), "omb-wake-retry-"));
  dirs.push(dir);
  const world = { at: START, started: [] as string[], prepared: [] as string[] };
  let tasks = 0;
  const options: RoutineManagerOptions = {
    file: join(dir, "routines.json"), now: () => world.at, botState: () => "ready",
    createTask: (botId) => ({ threadId: `${botId}-thread-${++tasks}` }),
    startTurn: async (_botId, threadId) => { world.started.push(threadId); },
    prepareRun: (run) => {
      world.prepared.push(run.id);
      const answer = wakes.shift() ?? null;
      return answer === "hang" ? new Promise<string | null>(() => {}) : Promise.resolve(answer);
    },
    preparing: RUN_COMPUTER_LINES.waking,
  };
  const h = {
    world, options,
    manager: new RoutineManager(options),
    restart() { h.manager.close(); h.manager = new RoutineManager(options); managers.push(h.manager); return h.manager; },
    /** Until the computer's answer is in and the pass it set off has ended. */
    async idle() {
      do await new Promise((resolve) => setImmediate(resolve)); while (h.manager.isTicking);
    },
    /** A scheduler pass at `at`, then one more once the computer's answer is in. */
    async passAt(at: number) {
      world.at = at;
      await h.manager.tick();
      await h.idle();
      await h.manager.tick();
      await h.idle();
    },
    runs: () => h.manager.listRuns(),
  };
  managers.push(h.manager);
  const routine = h.manager.create({ name: "Out of hours", prompt: "Check the inbox", botId: "cloud-bot", schedule: schedule ?? { type: "interval", everyMinutes, anchorAt: START } });
  return { ...h, routine, due: routine.nextRunAt! };
}

describe("a scheduled run whose cloud computer did not wake", () => {
  it("stays queued, says when it tries again, and starts on the second try", async () => {
    const h = harness([RUN_COMPUTER_LINES.noWake, null]);
    await h.passAt(h.due);
    expect(h.world.started).toEqual([]);
    const [run] = h.runs();
    expect(run).toMatchObject({ status: "queued", scheduledFor: h.due, retryAt: h.due + WAKE_RETRY_AFTER_MS[0]!, wakeRetries: 1, attentionCode: "routines.server.wakeRetry" });
    expect(run!.attention).toMatch(/^The cloud desktop did not wake, so this run has not started yet\. It tries again at /);
    expect(run).not.toHaveProperty("error");

    // Nothing is asked of the computer before the retry is due.
    await h.passAt(h.due + WAKE_RETRY_AFTER_MS[0]! - MINUTE);
    expect(h.world.prepared).toHaveLength(1);

    await h.passAt(h.due + WAKE_RETRY_AFTER_MS[0]!);
    expect(h.world.prepared).toEqual([run!.id, run!.id]);
    expect(h.world.started).toHaveLength(1);
    expect(h.runs()).toMatchObject([{ id: run!.id, status: "running", scheduledFor: h.due }]);
  });

  it("never starts the same occurrence twice: later passes leave it alone, and the next occurrence is a run of its own", async () => {
    const h = harness([RUN_COMPUTER_LINES.noWake, null, null]);
    await h.passAt(h.due);
    await h.passAt(h.due + WAKE_RETRY_AFTER_MS[0]!);
    for (const later of [1, 10, 25]) await h.passAt(h.due + WAKE_RETRY_AFTER_MS[0]! + later * MINUTE);
    expect(h.world.started).toHaveLength(1);
    const threadId = h.runs()[0]!.threadId!;
    h.manager.handleRuntimeEvent({ eventId: `done-${threadId}`, provider: "fake", threadId, createdAt: new Date(h.world.at).toISOString(), type: "turn.completed", ok: true } as Parameters<RoutineManager["handleRuntimeEvent"]>[0]);
    expect(h.runs()[0]).toMatchObject({ status: "completed" });
    await h.passAt(h.due + 60 * MINUTE);
    expect(h.world.started).toHaveLength(2);
    expect(h.runs().map((run) => run.scheduledFor).sort()).toEqual([h.due, h.due + 60 * MINUTE]);
  });

  it("keeps its retry across a restart and starts it once", async () => {
    const h = harness([RUN_COMPUTER_LINES.noWake, null]);
    await h.passAt(h.due);
    const [before] = h.runs();
    h.restart();
    expect(h.runs()).toMatchObject([{ id: before!.id, status: "queued", retryAt: before!.retryAt, wakeRetries: 1 }]);
    await h.passAt(before!.retryAt!);
    await h.passAt(before!.retryAt! + MINUTE);
    expect(h.world.started).toHaveLength(1);
    expect(h.runs()).toMatchObject([{ id: before!.id, status: "running" }]);
  });

  it("tries three more times at most, then fails saying the next scheduled run tries again", async () => {
    const h = harness([RUN_COMPUTER_LINES.noWake, RUN_COMPUTER_LINES.noWake, RUN_COMPUTER_LINES.noWake, RUN_COMPUTER_LINES.noWake]);
    await h.passAt(h.due);
    for (const after of WAKE_RETRY_AFTER_MS) await h.passAt(h.due + after);
    expect(h.world.prepared).toHaveLength(4);
    expect(h.world.started).toEqual([]);
    expect(h.runs()).toMatchObject([{ status: "failed", errorCode: "routines.server.noWakeRetried",
      error: "The cloud desktop did not wake, even after more tries, so this run did not start. The next scheduled run tries again." }]);
    expect(h.manager.listRoutines()[0]).toMatchObject({ enabled: true });
  });

  it("gives up before the next occurrence is due, which takes over", async () => {
    // Every 15 minutes: one retry fits before the next occurrence, a second would not.
    const h = harness([RUN_COMPUTER_LINES.noWake, RUN_COMPUTER_LINES.noWake, null], 15);
    await h.passAt(h.due);
    expect(h.runs()).toMatchObject([{ status: "queued", retryAt: h.due + WAKE_RETRY_AFTER_MS[0]! }]);
    await h.passAt(h.due + WAKE_RETRY_AFTER_MS[0]!);
    expect(h.runs()).toMatchObject([{ status: "failed", error: "The cloud desktop did not wake, even after more tries, so this run did not start. The next scheduled run tries again." }]);
    await h.passAt(h.due + 15 * MINUTE);
    expect(h.world.started).toHaveLength(1);
    expect(h.runs().find((run) => run.status === "running")).toMatchObject({ scheduledFor: h.due + 15 * MINUTE });
  });

  it("gives way when a retry is still waiting for its computer as the next occurrence comes due", async () => {
    const h = harness([RUN_COMPUTER_LINES.noWake, "hang", null], 15);
    await h.passAt(h.due);
    const [first] = h.runs();
    await h.passAt(first!.retryAt!);
    expect(h.runs()).toMatchObject([{ id: first!.id, status: "queued", attention: RUN_COMPUTER_LINES.waking }]);
    await h.passAt(h.due + 15 * MINUTE);
    expect(h.runs().find((run) => run.id === first!.id)).toMatchObject({ status: "failed", error: "The cloud desktop did not wake, even after more tries, so this run did not start. The next scheduled run tries again." });
    const next = h.runs().find((run) => run.id !== first!.id)!;
    expect(next).toMatchObject({ scheduledFor: h.due + 15 * MINUTE, status: "running" });
    expect(next).not.toHaveProperty("skipped");
    expect(h.world.started).toHaveLength(1);
  });

  it("never queues a try outside an interval schedule's hours, and gives one up that comes due outside them", async () => {
    const window = { type: "interval", everyMinutes: 15, anchorAt: START, window: { start: "08:00", end: "09:00" } } as const;
    // Three tries from 08:45: 08:50 and 08:57 are inside the window, 09:05 would not be.
    const h = harness([RUN_COMPUTER_LINES.noWake, RUN_COMPUTER_LINES.noWake, RUN_COMPUTER_LINES.noWake, null], 15, window);
    const last = START + 45 * MINUTE;
    await h.passAt(last);
    const [run] = h.runs().filter((candidate) => candidate.scheduledFor === last);
    expect(run).toMatchObject({ status: "queued", retryAt: START + 50 * MINUTE });
    await h.passAt(START + 50 * MINUTE);
    expect(h.runs().find((candidate) => candidate.id === run!.id)).toMatchObject({ status: "queued", retryAt: START + 57 * MINUTE });
    await h.passAt(START + 57 * MINUTE);
    expect(h.runs().find((candidate) => candidate.id === run!.id)).toMatchObject({ status: "failed", error: "The cloud desktop did not wake, even after more tries, so this run did not start. The next scheduled run tries again." });
    expect(h.manager.hasActiveRuns()).toBe(false);

    // A try queued inside the window whose pass only comes after it ends is given up, not left waiting for tomorrow.
    const late = harness([RUN_COMPUTER_LINES.noWake, RUN_COMPUTER_LINES.noWake, null], 15, window);
    await late.passAt(last);
    await late.passAt(START + 50 * MINUTE);
    expect(late.runs().find((candidate) => candidate.scheduledFor === last)).toMatchObject({ status: "queued", retryAt: START + 57 * MINUTE });
    await late.passAt(START + 62 * MINUTE);
    expect(late.runs().find((candidate) => candidate.scheduledFor === last)).toMatchObject({ status: "failed", error: "The cloud desktop did not wake, even after more tries, so this run did not start. The next scheduled run tries again." });
    expect(late.manager.hasActiveRuns()).toBe(false);
    expect(late.world.started).toEqual([]);
  });

  it("tries a once-only routine's run again, though the routine turned itself off when the run was made", async () => {
    const at = START + 30 * MINUTE;
    const h = harness([RUN_COMPUTER_LINES.noWake, null], 60, { type: "once", at });
    await h.passAt(at);
    expect(h.manager.listRoutines()[0]).toMatchObject({ enabled: false, nextRunAt: null });
    expect(h.runs()).toMatchObject([{ status: "queued", retryAt: at + WAKE_RETRY_AFTER_MS[0]!, wakeRetries: 1 }]);
    await h.passAt(at + WAKE_RETRY_AFTER_MS[0]!);
    expect(h.world.started).toHaveLength(1);
    expect(h.runs()).toMatchObject([{ status: "running", scheduledFor: at }]);
  });

  it("gives up a try left waiting while the server slept past the next occurrence, which then runs in its place", async () => {
    const h = harness([RUN_COMPUTER_LINES.noWake, null, null], 60, { type: "cron", expression: "0 * * * *", timeZone: "UTC" });
    await h.passAt(h.due);
    const [first] = h.runs();
    expect(first).toMatchObject({ status: "queued", wakeRetryUntil: h.due + 60 * MINUTE });
    await h.passAt(h.due + 14 * 60 * MINUTE);
    expect(h.runs().find((run) => run.id === first!.id)).toMatchObject({ status: "failed", error: "The cloud desktop did not wake, even after more tries, so this run did not start. The next scheduled run tries again." });
    expect(h.runs().some((run) => run.skipped?.behind === first!.id)).toBe(false);
    expect(h.world.prepared.filter((id) => id === first!.id)).toHaveLength(1);
  });

  it("fails at once for any other reason it did not start: those are not tried again", async () => {
    for (const reason of [RUN_COMPUTER_LINES.noAnswer, RUN_COMPUTER_LINES.afterRestart, RUN_COMPUTER_LINES.wakeRefused]) {
      const h = harness([reason, null]);
      await h.passAt(h.due);
      await h.passAt(h.due + 30 * MINUTE);
      expect(h.world.prepared).toHaveLength(1);
      expect(h.world.started).toEqual([]);
      expect(h.runs()).toMatchObject([{ status: "failed", error: reason }]);
      expect(h.runs()[0]).not.toHaveProperty("wakeRetries");
    }
  });
});

describe("whether a run that did not wake is tried again", () => {
  const run = () => ({ status: "queued" as const, target: "bot" as const, scheduledFor: START, attention: "x" as string | undefined });
  const every = { type: "interval", everyMinutes: 60, anchorAt: START } as const;
  const hourly = { enabled: true, nextRunAt: START + 60 * MINUTE, schedule: every };

  it("is not for a run its schedule did not start, a paused routine, or a routine with no time left before the next occurrence", () => {
    expect(wakeRetry(run(), RUN_COMPUTER_LINES.noWake, undefined, START + 4 * MINUTE)).toBe(RUN_COMPUTER_LINES.noWake);
    expect(wakeRetry(run(), RUN_COMPUTER_LINES.noWake, { enabled: false, nextRunAt: null, schedule: every }, START + 4 * MINUTE)).toBe(RUN_COMPUTER_LINES.noWake);
    expect(wakeRetry(run(), RUN_COMPUTER_LINES.noWake, { enabled: true, nextRunAt: START + 9 * MINUTE, schedule: every }, START + 4 * MINUTE)).toBe(RUN_COMPUTER_LINES.noWake);
    // A run that already started once (a restart put it back) is not this run's to try again.
    expect(wakeRetry({ ...run(), startedAt: START + MINUTE, retried: "restarted" as const }, RUN_COMPUTER_LINES.noWake, hourly, START + 4 * MINUTE)).toBe(RUN_COMPUTER_LINES.noWake);
  });

  it("waits at least a short gap after a try that ended late", () => {
    const late = run();
    expect(wakeRetry(late, RUN_COMPUTER_LINES.noWake, hourly, START + 30 * MINUTE)).toBe(true);
    expect(late).toMatchObject({ retryAt: START + 32 * MINUTE, wakeRetries: 1 });
  });

  it("gives way to the next occurrence only while the run has not started since", () => {
    expect(waitsToWakeAgain({ status: "queued", wakeRetries: 1 })).toBe(true);
    expect(waitsToWakeAgain({ status: "queued" })).toBe(false);
    expect(waitsToWakeAgain({ status: "queued", wakeRetries: 1, startedAt: START + 5 * MINUTE, retried: "restarted" })).toBe(false);
    expect(waitsToWakeAgain({ status: "running", wakeRetries: 1, startedAt: START + 5 * MINUTE })).toBe(false);
  });

  it("ends a once-only routine's tries without promising a next run, and bounds them by how late a missed run still starts", () => {
    const onceOnly = { enabled: false, nextRunAt: null, schedule: { type: "once", at: START } } as const;
    const first = run();
    expect(wakeRetry(first, RUN_COMPUTER_LINES.noWake, onceOnly, START + 4 * MINUTE)).toBe(true);
    expect(first).toMatchObject({ wakeRetries: 1, wakeRetryUntil: START + WAKE_RETRY_LAST_MS });
    expect(WAKE_RETRY_LAST_MS).toBe(CATCH_UP_MS);
    expect(wakeRetry({ ...run(), wakeRetries: 3 }, RUN_COMPUTER_LINES.noWake, onceOnly, START + 25 * MINUTE)).toBe("The cloud desktop did not wake, even after more tries, so this run did not start.");
  });
});
