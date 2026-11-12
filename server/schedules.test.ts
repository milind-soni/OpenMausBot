import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { localInstant, nextScheduleRun, resumeDelay } from "./schedule-time.ts";
import { ScheduleStore, Scheduler, canManageSchedule } from "./schedules.ts";
import { canUseBackup, turnSelection } from "./backup-model.ts";
import type { ScheduleInput } from "./schedule-types.ts";
const instant = (text: string) => Date.parse(text);
const input = (repeat: ScheduleInput["repeat"]): ScheduleInput => ({ target: { botId: "bot" }, prompt: "Review today's work", repeat, timezone: "UTC" });
afterEach(() => vi.useRealTimers());

describe("schedule time calculations", () => {
  it("covers once, daily, weekdays, selected weekdays, and anchored hourly repeats", () => {
    const after = instant("2026-11-13T12:00:00Z"); // Friday
    expect(nextScheduleRun({ kind: "once", at: "2026-11-13T13:00:00Z" }, "UTC", after)).toBe("2026-11-13T13:00:00.000Z");
    expect(nextScheduleRun({ kind: "once", at: "2026-11-13T12:00:00Z" }, "UTC", after)).toBeNull();
    expect(nextScheduleRun({ kind: "daily", time: "09:00" }, "UTC", after)).toBe("2026-11-14T09:00:00.000Z");
    expect(nextScheduleRun({ kind: "weekdays", time: "09:00" }, "UTC", after)).toBe("2026-11-16T09:00:00.000Z");
    expect(nextScheduleRun({ kind: "weekly", time: "09:00", days: [0, 4] }, "UTC", after)).toBe("2026-11-15T09:00:00.000Z");
    expect(nextScheduleRun({ kind: "every", hours: 4 }, "UTC", after + 25 * 3600_000, after)).toBe("2026-11-14T16:00:00.000Z");
  });
  it.each([
    ["America/New_York", "2026-03-08", "02:30", "2026-03-08T07:30:00.000Z"],
    ["Europe/Berlin", "2026-03-29", "02:30", "2026-03-29T01:30:00.000Z"],
    ["America/New_York", "2026-11-01", "01:30", "2026-11-01T05:30:00.000Z"],
    ["Europe/Berlin", "2026-10-25", "02:30", "2026-10-25T00:30:00.000Z"],
  ])("resolves missing/folded times in %s on %s", (zone, date, time, expected) => expect(localInstant(date, time, zone)).toBe(expected));
  it.each([
    ["America/New_York", "2026-11-01T05:45:00Z", "01:30", "2026-11-02T06:30:00.000Z"],
    ["Europe/Berlin", "2026-10-25T00:45:00Z", "02:30", "2026-10-26T01:30:00.000Z"],
  ])("does not run twice in the folded hour in %s", (zone, after, time, expected) => expect(nextScheduleRun({ kind: "daily", time }, zone, instant(after))).toBe(expected));
  it("keeps local daily time across both DST changes", () => {
    expect(nextScheduleRun({ kind: "daily", time: "09:00" }, "America/New_York", instant("2026-03-07T14:00:00Z"))).toBe("2026-03-08T13:00:00.000Z");
    expect(nextScheduleRun({ kind: "daily", time: "09:00" }, "Europe/Berlin", instant("2026-10-24T07:00:00Z"))).toBe("2026-10-25T08:00:00.000Z");
  });
});
describe("durable scheduler", () => {
  it("fires server-side without a client, retains busy work, and dispatches it once", async () => {
    vi.useFakeTimers(); let now = instant("2026-11-12T00:00:00Z"), busy = true;
    const store = new ScheduleStore(join(DATA_DIR, "busy"), () => now);
    const schedule = store.create(input({ kind: "once", at: new Date(now + 60_000).toISOString() }));
    const sent: string[] = [];
    const scheduler = new Scheduler(store, async job => { if (busy) return false; store.claim(job.id); sent.push(job.prompt); store.finish(job.id, "sent"); return true; }, () => now);
    scheduler.start(); await scheduler.wake(); now += 60_000; await vi.advanceTimersByTimeAsync(60_000);
    expect(store.pending()).toHaveLength(1); expect(sent).toHaveLength(0);
    const restart = new ScheduleStore(join(DATA_DIR, "busy"), () => now); expect(restart.pending()).toHaveLength(1);
    busy = false; await scheduler.wake(); await scheduler.wake();
    expect(sent).toEqual([schedule.prompt]); expect(store.get(schedule.id)?.lastRun?.outcome).toBe("sent"); scheduler.stop();
  });
  it("catches up once within grace, records older misses, and never replays a backlog", () => {
    let now = instant("2026-11-12T00:00:00Z"); const store = new ScheduleStore(join(DATA_DIR, "grace"), () => now);
    const daily = store.create(input({ kind: "daily", time: "09:00" }));
    now = instant("2026-11-12T10:00:00Z"); store.collectDue(); store.collectDue(); expect(store.pending()).toHaveLength(1);
    store.finish(store.pending()[0].id, "sent");
    now = instant("2026-11-16T12:00:00Z"); store.collectDue();
    expect(store.pending()).toHaveLength(0); expect(store.get(daily.id)?.lastRun?.outcome).toBe("missed");
    expect(store.get(daily.id)?.nextRunAt).toBe("2026-11-17T09:00:00.000Z");
  });
  it("pauses automatic runs and cancellation removes pending work", () => {
    let now = instant("2026-11-12T00:00:00Z"); const store = new ScheduleStore(join(DATA_DIR, "pause"), () => now);
    const schedule = store.create(input({ kind: "once", at: new Date(now + 60_000).toISOString() })); store.pause(true); now += 60_000; store.collectDue(); expect(store.pending()).toHaveLength(0);
    store.pause(false); store.collectDue(); expect(store.pending()).toHaveLength(1); store.remove(schedule.id); expect(store.pending()).toHaveLength(0);
  });
  it("updates one retry per conversation with 15/30/60-minute backoff capped at six hours", () => {
    const now = instant("2026-11-12T00:00:00Z"), store = new ScheduleStore(join(DATA_DIR, "retry"), () => now);
    const context = { botId: "bot", threadId: "thread", userMessageId: "message", request: "Finish the report", attempt: 0 };
    const first = store.upsertResume({ botId: "bot" }, context); expect(Date.parse(first.nextRunAt!) - now).toBe(15 * 60_000);
    const second = store.upsertResume({ botId: "bot" }, context); expect(second.id).toBe(first.id); expect(Date.parse(second.nextRunAt!) - now).toBe(30 * 60_000);
    const third = store.upsertResume({ botId: "bot" }, context); expect(Date.parse(third.nextRunAt!) - now).toBe(60 * 60_000);
    expect(store.snapshot().schedules).toHaveLength(1); expect(resumeDelay(100)).toBe(6 * 3600_000);
    const known = store.upsertResume({ botId: "bot" }, context, "2026-11-12T05:00:00Z"); expect(known.nextRunAt).toBe("2026-11-12T05:02:00.000Z");
    store.cancelResume("thread"); expect(store.snapshot().schedules).toHaveLength(0);
  });
  it("enforces caps, validates input, and scopes bot access", () => {
    const now = instant("2026-11-12T00:00:00Z"), store = new ScheduleStore(join(DATA_DIR, "cap"), () => now);
    for (let n = 0; n < 20; n++) store.create(input({ kind: "every", hours: 4 }), "bot", "bot");
    expect(() => store.create(input({ kind: "every", hours: 4 }), "bot", "bot")).toThrow(/20/);
    expect(() => store.create(input({ kind: "weekly", days: [], time: "25:00" }))).toThrow();
    expect(canManageSchedule({ target: { groupId: "room" }, createdBy: "bot" }, "bot", [{ id: "room", memberIds: ["bot"] }])).toBe(true);
    expect(canManageSchedule({ target: { botId: "other" }, createdBy: "bot" }, "bot", [])).toBe(false);
    expect(canManageSchedule({ target: { botId: "bot" }, createdBy: "other" }, "bot", [])).toBe(false);
  });
});
describe("backup decisions", () => {
  const primary = { instanceId: "main", model: "main-model" }, backup = { instanceId: "backup", model: "backup-model" };
  it("rejects missing, unavailable, same-app and exhausted backups", () => {
    expect(canUseBackup(primary, backup, true, "unknown")).toBe(true);
    expect(canUseBackup(primary, backup, false, "ok")).toBe(false);
    expect(canUseBackup(primary, backup, true, "exhausted")).toBe(false);
    expect(canUseBackup(primary, undefined, true, "ok")).toBe(false);
    expect(canUseBackup(primary, primary, true, "ok")).toBe(false);
  });
  it("switches back only at selection for a new turn with a fresh known primary reading", () => {
    const bot = { modelSelection: primary, backupModelSelection: backup, usingBackup: true };
    expect(turnSelection(bot, "unknown")).toBe(backup); expect(turnSelection(bot, "exhausted")).toBe(backup);
    expect(turnSelection(bot, "ok")).toBe(primary); expect(turnSelection(bot, "low")).toBe(primary);
  });
});
