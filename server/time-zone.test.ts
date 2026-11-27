import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RoutineManager, type RoutineManagerOptions } from "./routines.ts";
import { adoptSavedTimeZone, currentTimeZone, knownTimeZone, TIME_ZONE_FILE, useTimeZone } from "./time-zone.ts";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-time-zone-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function manager(dataDir: string, now: () => number) {
  const options = {
    file: join(dataDir, "routines.json"), now, emit: () => {}, botState: () => "ready", goalState: () => "ready",
    createTask: () => ({ threadId: "thread-1" }), createGoalTask: () => ({ threadId: "goal-1" }),
    startTurn: async () => {}, startGoal: async () => {}, interruptTurn: async () => {}, interruptGoal: async () => {},
  } as unknown as RoutineManagerOptions;
  return new RoutineManager(options);
}

describe("the zone a Cloud home tells time in", () => {
  it("takes only IANA zone names the runtime knows", () => {
    for (const zone of ["UTC", "Asia/Kolkata", "Europe/London", "America/Argentina/Buenos_Aires", "Etc/GMT+5"]) expect(knownTimeZone(zone), zone).toBe(zone);
    for (const bad of ["+05:30", "IST", "Mars/Olympus_Mons", "../etc/passwd", "Asia/Kolkata\n", "", 330, null, "A".repeat(70)]) expect(knownTimeZone(bad), String(bad)).toBeNull();
  });

  it("saves the owner's zone, runs in it, and takes it back after a restart", () => {
    const dataDir = tempDir();
    const env: NodeJS.ProcessEnv = {};
    expect(adoptSavedTimeZone(dataDir, env)).toBeNull();
    expect(useTimeZone(dataDir, "Asia/Kolkata", env)).toBe(true);
    expect(env.TZ).toBe("Asia/Kolkata");
    expect(currentTimeZone(env)).toBe("Asia/Kolkata");
    expect(JSON.parse(readFileSync(join(dataDir, TIME_ZONE_FILE), "utf8"))).toEqual({ version: 1, timeZone: "Asia/Kolkata" });
    if (process.platform !== "win32") expect(statSync(join(dataDir, TIME_ZONE_FILE)).mode & 0o777).toBe(0o600);
    expect(useTimeZone(dataDir, "Asia/Kolkata", env)).toBe(false);
    const restarted: NodeJS.ProcessEnv = {};
    expect(adoptSavedTimeZone(dataDir, restarted)).toBe("Asia/Kolkata");
    expect(restarted.TZ).toBe("Asia/Kolkata");
  });

  it("moves this process's clock: a local hour reads in the new zone at once", () => {
    vi.stubEnv("TZ", "UTC");
    const at = Date.parse("2026-10-18T12:00:00Z");
    expect(new Date(at).getHours()).toBe(12);
    useTimeZone(tempDir(), "Asia/Kolkata");
    expect(new Date(at).getHours()).toBe(17);
    expect(new Date(at).getMinutes()).toBe(30);
  });

  it("moves a daily time and an interval kept to some hours with the zone, and leaves cron, one-time and plain intervals", () => {
    vi.stubEnv("TZ", "UTC");
    const dataDir = tempDir();
    const now = Date.parse("2026-10-18T12:00:00Z");
    const routines = manager(dataDir, () => now);
    const base = { prompt: "Say the time", botId: "bot-1" };
    const daily = routines.create({ ...base, name: "Daily", schedule: { type: "daily", time: "18:35", weekdays: [0, 1, 2, 3, 4, 5, 6] } });
    const office = routines.create({ ...base, name: "Office hours", schedule: { type: "interval", everyMinutes: 60, anchorAt: now, window: { start: "09:00", end: "17:00" } } });
    const cron = routines.create({ ...base, name: "Cron", schedule: { type: "cron", expression: "0 9 * * *", timeZone: "Europe/London" } });
    const once = routines.create({ ...base, name: "Once", schedule: { type: "once", at: now + 3_600_000 } });
    const plain = routines.create({ ...base, name: "Plain", schedule: { type: "interval", everyMinutes: 30, anchorAt: now } });
    const paused = routines.create({ ...base, name: "Paused", enabled: false, schedule: { type: "daily", time: "07:00", weekdays: [0, 1, 2, 3, 4, 5, 6] } });
    const before = new Map(routines.listRoutines().map((routine) => [routine.id, routine.nextRunAt]));
    expect(before.get(daily.id)).toBe(Date.parse("2026-10-18T18:35:00Z"));

    // The owner is in India: 18:35 is 13:05 UTC, and office hours open at 09:00 there, 03:30 UTC.
    vi.stubEnv("TZ", "Asia/Kolkata");
    expect(routines.rescheduleLocalTimes()).toBe(2);
    const after = new Map(routines.listRoutines().map((routine) => [routine.id, routine.nextRunAt]));
    expect(after.get(daily.id)).toBe(Date.parse("2026-10-18T13:05:00Z"));
    expect(after.get(office.id)).not.toBe(before.get(office.id));
    expect(new Date(after.get(office.id)!).getHours()).toBeGreaterThanOrEqual(9);
    for (const kept of [cron, once, plain, paused]) expect(after.get(kept.id), kept.name).toBe(before.get(kept.id));
    // Saved: a restart keeps the moved times.
    expect(manager(dataDir, () => now).listRoutines().find((routine) => routine.id === daily.id)?.nextRunAt).toBe(Date.parse("2026-10-18T13:05:00Z"));
    expect(routines.rescheduleLocalTimes()).toBe(0);
  });
});
