import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LimitResetClock } from "./limit-resets.ts";
import { LIMIT_ACTIVE_MS, LIMIT_IDLE_POLL_MS, LIMIT_POLL_MS, limitReadDue, RESET_READ_AFTER_MS, retryAfterFailureMs } from "./limit-poll.ts";
import { parseClaudeUsage, type PlanUsageReport } from "./plan-usage.ts";
import { RoutineManager, type RoutineRun } from "./routines.ts";
import type { RuntimeEvent } from "../shared/runtime-events.ts";

const NOW = Date.parse("2026-10-19T10:00:00Z");
const MINUTE = 60_000, HOUR = 60 * MINUTE;
const iso = (at: number) => new Date(at).toISOString();
const accounts = [{ id: "claude", name: "Claude", driver: "claude" as const, environment: {} }];
/** Claude's usage as its endpoint answers: [percent used, when the window resets]. */
const usage = (fiveHour: [number, number], weekly: [number, number]): PlanUsageReport => ({
  fetchedAt: iso(Date.now()),
  providers: [{ id: "claude", name: "Claude", driver: "claude", ok: true, error: null, ...parseClaudeUsage({
    five_hour: { utilization: fiveHour[0], resets_at: iso(fiveHour[1]) },
    seven_day: { utilization: weekly[0], resets_at: iso(weekly[1]) },
  }) }],
});
const turnEvent = (threadId: string): RuntimeEvent => ({ eventId: "e", provider: "claudeAgent", createdAt: iso(Date.now()), threadId, type: "turn.started" }) as RuntimeEvent;

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("limitReadDue", () => {
  const state = { now: NOW, checkedAt: NOW - 2 * MINUTE, lastTurnAt: -Infinity, resets: [] as number[] };

  it("keeps usage five minutes fresh while turns run", () => {
    const running = { ...state, lastTurnAt: NOW - MINUTE };
    expect(limitReadDue(running)).toBe(false);
    expect(limitReadDue({ ...running, checkedAt: NOW - LIMIT_POLL_MS })).toBe(true);
    expect(limitReadDue({ ...running, lastTurnAt: NOW - LIMIT_ACTIVE_MS, checkedAt: NOW - LIMIT_POLL_MS }), "turns ended a while ago").toBe(false);
  });

  it("on a quiet home, reads once after each known reset and otherwise hourly", () => {
    expect(limitReadDue({ ...state, checkedAt: NOW - 59 * MINUTE })).toBe(false);
    expect(limitReadDue({ ...state, checkedAt: NOW - LIMIT_IDLE_POLL_MS })).toBe(true);
    const reset = NOW - RESET_READ_AFTER_MS;
    expect(limitReadDue({ ...state, resets: [reset] }), "a reset passed since the last read").toBe(true);
    expect(limitReadDue({ ...state, resets: [reset], checkedAt: NOW }), "read already after it").toBe(false);
    expect(limitReadDue({ ...state, resets: [NOW + MINUTE] }), "not yet").toBe(false);
  });

  it("reads at once when it never read", () => {
    expect(limitReadDue({ ...state, checkedAt: 0 })).toBe(true);
  });

  it("reads at once when the clock was set back past the last read", () => {
    expect(limitReadDue({ ...state, checkedAt: NOW + 2 * HOUR })).toBe(true);
    expect(limitReadDue({ ...state, checkedAt: NOW + 2 * HOUR, lastTurnAt: NOW + 2 * HOUR })).toBe(true);
  });

  it("tries a failed read again in minutes, backing off to the hourly read", () => {
    expect([1, 2, 3, 4, 5].map(retryAfterFailureMs)).toEqual([5 * MINUTE, 10 * MINUTE, 20 * MINUTE, 40 * MINUTE, HOUR]);
    expect(limitReadDue({ ...state, checkedAt: NOW - 5 * MINUTE, failures: 1 })).toBe(true);
    expect(limitReadDue({ ...state, checkedAt: NOW - 5 * MINUTE, failures: 2 })).toBe(false);
    expect(limitReadDue({ ...state, checkedAt: NOW - 4 * MINUTE, failures: 1 }), "never a tight loop").toBe(false);
  });
});

describe("the limit clock on a quiet home", () => {
  it("reads usage once, then nothing for the next hour, though an engine is held and an automation waits", async () => {
    vi.useFakeTimers({ now: NOW });
    const loadUsage = vi.fn(async () => usage([100, NOW + 23 * HOUR], [40, NOW + 5 * 24 * HOUR]));
    const instance = new LimitResetClock({ accounts: () => accounts, loadUsage, waiting: () => true });
    instance.noteRefusal("claude", NOW + 23 * HOUR);
    instance.start();
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(loadUsage, "the read just after the refusal").toHaveBeenCalledTimes(1);
    loadUsage.mockClear();
    await vi.advanceTimersByTimeAsync(57 * MINUTE);
    expect(loadUsage, "every five minutes before: twelve reads an hour").not.toHaveBeenCalled();
    expect(instance.blockedUntil("claude"), "still held").toBe(NOW + 23 * HOUR);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(loadUsage, "the hourly read, which still ends a hold that reset early").toHaveBeenCalledTimes(1);
    instance.stop();
  });

  it("goes back to five-minute reads while turns run", async () => {
    vi.useFakeTimers({ now: NOW });
    const loadUsage = vi.fn(async () => usage([100, NOW + 23 * HOUR], [40, NOW + 5 * 24 * HOUR]));
    const instance = new LimitResetClock({ accounts: () => accounts, loadUsage, waiting: () => true });
    instance.start();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(loadUsage).toHaveBeenCalledTimes(1);
    for (let minute = 0; minute < 30; minute++) {
      instance.noteRuntimeEvent("codex", turnEvent(`t${minute}`));
      await vi.advanceTimersByTimeAsync(MINUTE);
    }
    expect(loadUsage.mock.calls.length).toBeGreaterThanOrEqual(6);
    instance.stop();
  });

  it("answers fresh when someone looks at the limits", async () => {
    vi.useFakeTimers({ now: NOW });
    let report = usage([100, NOW + 23 * HOUR], [40, NOW + 5 * 24 * HOUR]);
    const loadUsage = vi.fn(async () => ({ ...report, fetchedAt: iso(Date.now()) }));
    const instance = new LimitResetClock({ accounts: () => accounts, loadUsage, waiting: () => true });
    instance.start();
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(loadUsage).toHaveBeenCalledTimes(1);
    report = usage([20, NOW + 4 * HOUR], [10, NOW + 5 * 24 * HOUR]);
    await instance.ensureFresh();
    expect(loadUsage).toHaveBeenCalledTimes(2);
    expect(instance.report().checkedAt).toBe(Date.now());
    expect(instance.limit("claude")?.usedPercent).toBe(20);
    instance.stop();
  });

  it("still starts a waiting limit-reset automation on time, and reads the next reset just after", async () => {
    vi.useFakeTimers({ now: NOW });
    const dir = mkdtempSync(join(tmpdir(), "omb-limit-poll-"));
    dirs.push(dir);
    const reset = NOW + 20 * MINUTE;
    let report = usage([100, reset], [40, NOW + 5 * 24 * HOUR]);
    const loadUsage = vi.fn(async () => ({ ...report, fetchedAt: iso(Date.now()) }));
    const started: string[] = [];
    let routines: RoutineManager | null = null;
    const clock = new LimitResetClock({ accounts: () => accounts, loadUsage, onChange: () => routines?.retimeLimitResets(),
      waiting: () => Boolean(routines?.listRoutines().some((routine) => routine.enabled && routine.schedule.type === "limit_reset")) });
    routines = new RoutineManager({
      file: join(dir, "routines.json"), now: () => Date.now(), emit: () => {}, botState: () => "ready" as const,
      createTask: () => ({ threadId: "thread-1" }), joinConversation: (run: RoutineRun) => run.sourceThreadId ?? null,
      startTurn: async (_botId: string, threadId: string) => { started.push(threadId); },
      limitResetAt: (engine: string) => clock.resetAt(engine),
    });
    routines.create({ name: "Carry on", prompt: "Carry on.", botId: "scout", schedule: { type: "limit_reset", engine: "claude", repeat: "every_reset" } });
    clock.start();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(clock.resetAt("claude")).toBe(reset);
    expect(routines.listRoutines()[0]!.nextRunAt, "timed by the first read").toBe(reset + 60_000);
    loadUsage.mockClear();
    // The window rolls over at its reset: the next one ends five hours later.
    report = usage([5, reset + 5 * HOUR], [2, NOW + 5 * 24 * HOUR]);
    await vi.advanceTimersByTimeAsync(reset - Date.now() + 30_000);
    expect(loadUsage, "nothing read before the reset").not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(MINUTE);
    await routines.tick();
    expect(started, "the automation starts a minute after the reset").toEqual(["thread-1"]);
    expect(loadUsage, "not re-timed before it ran").not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(loadUsage, "read just after the reset").toHaveBeenCalledTimes(1);
    expect(routines.listRoutines()[0]!.nextRunAt, "and timed to the next reset").toBe(reset + 5 * HOUR + 60_000);
    clock.stop();
    routines.stop();
  });
});

/** A clock and a RoutineManager wired as index.ts wires them. */
function wired(loadUsage: () => Promise<PlanUsageReport>, file?: string) {
  const dir = mkdtempSync(join(tmpdir(), "omb-limit-poll-"));
  dirs.push(dir);
  const started: string[] = [];
  let routines: RoutineManager | null = null;
  const clock = new LimitResetClock({ accounts: () => accounts, loadUsage, onChange: () => routines?.retimeLimitResets(), ...(file ? { file } : {}),
    waiting: () => Boolean(routines?.listRoutines().some((routine) => routine.enabled && routine.schedule.type === "limit_reset")) });
  routines = new RoutineManager({
    file: join(dir, "routines.json"), now: () => Date.now(), emit: () => {}, botState: () => "ready" as const,
    createTask: () => ({ threadId: `thread-${started.length + 1}` }), joinConversation: (run: RoutineRun) => run.sourceThreadId ?? null,
    startTurn: async (_botId: string, threadId: string) => { started.push(threadId); },
    limitResetAt: (engine: string) => clock.resetAt(engine),
  });
  return { clock, routines, started };
}
/** Claude's usage just after its five-hour window reset, before a turn starts the next one: only the weekly window has a reset. */
const unstarted = (weekly: [number, number]): PlanUsageReport => ({
  fetchedAt: iso(Date.now()),
  providers: [{ id: "claude", name: "Claude", driver: "claude", ok: true, error: null, ...parseClaudeUsage({
    five_hour: { utilization: 0, resets_at: null }, seven_day: { utilization: weekly[0], resets_at: iso(weekly[1]) },
  }) }],
});
const unreachable = (): PlanUsageReport => ({ fetchedAt: iso(Date.now()),
  providers: [{ id: "claude", name: "Claude", driver: "claude", ok: false, error: "Couldn't reach Claude", fiveHour: { available: false, remainingPercent: null, usedPercent: null, resetsAt: null }, weekly: { available: false, remainingPercent: null, usedPercent: null, resetsAt: null }, extra: [], models: [] } as never] });

describe("the limit clock and the automations that wait for a reset", () => {
  it("a read seconds after the reset (someone opens the limits) shows only Claude's weekly window: the automation still starts on time", async () => {
    vi.useFakeTimers({ now: NOW });
    const reset = NOW + 20 * MINUTE + 30_000;
    let report = usage([100, reset], [40, NOW + 4 * 24 * HOUR]);
    const { clock, routines, started } = wired(async () => ({ ...report, fetchedAt: iso(Date.now()) }));
    routines.create({ name: "Carry on", prompt: "Carry on.", botId: "scout", schedule: { type: "limit_reset", engine: "claude", repeat: "once" } });
    clock.start();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(routines.listRoutines()[0]!.nextRunAt).toBe(reset + 60_000);
    report = unstarted([40, NOW + 4 * 24 * HOUR]);
    await vi.advanceTimersByTimeAsync(reset + 10_000 - Date.now());
    await clock.ensureFresh(0);
    expect(clock.resetAt("claude"), "the weekly window now").toBe(NOW + 4 * 24 * HOUR);
    expect(routines.listRoutines()[0]!.nextRunAt, "not moved days away").toBe(reset + 60_000);
    await vi.advanceTimersByTimeAsync(MINUTE);
    await routines.tick();
    expect(started).toHaveLength(1);
    clock.stop();
    routines.stop();
  });

  it("a hold that ends a minute and a half after its window's reset: the read after the window ends the hold, and the automation still starts once", async () => {
    vi.useFakeTimers({ now: NOW });
    const reset = NOW + 20 * MINUTE + 30_000, held = reset + 90_000;
    let report = usage([100, reset], [40, NOW + 4 * 24 * HOUR]);
    const loadUsage = vi.fn(async () => ({ ...report, fetchedAt: iso(Date.now()) }));
    const { clock, routines, started } = wired(loadUsage);
    clock.noteRefusal("claude", held);
    routines.create({ name: "Carry on", prompt: "Carry on.", botId: "scout", schedule: { type: "limit_reset", engine: "claude", repeat: "every_reset" } });
    clock.start();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(routines.listRoutines()[0]!.nextRunAt, "timed by the hold, the later of the two").toBe(held + 60_000);
    report = usage([3, reset + 5 * HOUR], [2, NOW + 4 * 24 * HOUR]);
    loadUsage.mockClear();
    for (let at = Date.now(); at < held + 5 * MINUTE; at = Date.now()) {
      await vi.advanceTimersByTimeAsync(30_000);
      await routines.tick();
      if (Date.now() > held) expect(clock.blockedUntil("claude"), "the hold ended at its time").toBeNull();
    }
    expect(started, "once, after the hold").toHaveLength(1);
    // The read two minutes after the window's reset shows room, which ends the hold, 30 s before the automation is due.
    expect(loadUsage.mock.calls.length, "a read after the window's reset").toBeGreaterThanOrEqual(1);
    expect(routines.listRoutines()[0]!.nextRunAt, "then the next window").toBe(reset + 5 * HOUR + 60_000);
    clock.stop();
    routines.stop();
  });
});

describe("the limit clock after a restart, a clock change or a failed read", () => {
  it("reads at once after a restart that left an engine held", async () => {
    vi.useFakeTimers({ now: NOW });
    const dir = mkdtempSync(join(tmpdir(), "omb-limit-holds-"));
    dirs.push(dir);
    const file = join(dir, "limit-holds.json");
    new LimitResetClock({ accounts: () => accounts, file, now: () => NOW }).noteRefusal("claude", NOW + 23 * HOUR);
    const loadUsage = vi.fn(async () => usage([100, NOW + 23 * HOUR], [40, NOW + 5 * 24 * HOUR]));
    const restarted = new LimitResetClock({ accounts: () => accounts, file, loadUsage, waiting: () => false });
    expect(restarted.blockedUntil("claude"), "the hold came back").toBe(NOW + 23 * HOUR);
    restarted.start();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(loadUsage).toHaveBeenCalledTimes(1);
    restarted.stop();
  });

  it("reads at once when the clock is set back, not an hour after the time it had", async () => {
    vi.useFakeTimers({ now: NOW });
    const loadUsage = vi.fn(async () => usage([100, NOW + 23 * HOUR], [40, NOW + 5 * 24 * HOUR]));
    const instance = new LimitResetClock({ accounts: () => accounts, loadUsage, waiting: () => true });
    instance.start();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(loadUsage).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() - 3 * HOUR);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(loadUsage).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(loadUsage, "then quiet again").toHaveBeenCalledTimes(2);
    instance.stop();
  });

  it("tries a failed read again in minutes, backing off, with no tight loop, and goes back to hourly once one works", async () => {
    vi.useFakeTimers({ now: NOW });
    let failing = 3;
    const loadUsage = vi.fn(async () => {
      if (failing-- > 0) {
        if (failing === 1) throw new Error("offline");
        return unreachable();
      }
      return usage([100, NOW + 23 * HOUR], [40, NOW + 5 * 24 * HOUR]);
    });
    const instance = new LimitResetClock({ accounts: () => accounts, loadUsage, waiting: () => true });
    instance.start();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(loadUsage, "the first read, which fails").toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    expect(loadUsage, "no retry within minutes").toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(loadUsage, "five minutes later").toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(loadUsage, "ten minutes after that").toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    expect(loadUsage, "twenty after that, and it works").toHaveBeenCalledTimes(4);
    expect(instance.limit("claude")?.usedPercent).toBe(100);
    await vi.advanceTimersByTimeAsync(55 * MINUTE);
    expect(loadUsage, "hourly again").toHaveBeenCalledTimes(4);
    instance.stop();
  });
});
