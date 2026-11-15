import { describe, expect, it } from "vitest";

import { routineHealthOf } from "./routine-health.ts";
import type { RoutineRun } from "./routines.ts";

const run = (routineId: string, status: RoutineRun["status"], finishedAt: number, more: Partial<RoutineRun> = {}): RoutineRun => ({
  id: `${routineId}-${finishedAt}`, routineId, routineName: "Planted name", prompt: "Planted prompt", target: "bot", botId: "bot-1", runOn: "maus",
  scheduledFor: finishedAt, status, manual: false, createdAt: finishedAt, finishedAt, ...more,
});
const on = (id: string) => ({ id, enabled: true });

describe("a routine's health, from its saved run rows", () => {
  it("counts the failed and missed runs since the last one that completed, newest first", () => {
    const runs = [run("a", "completed", 10), run("a", "failed", 20), run("a", "missed", 30), run("a", "failed", 40)];
    expect(routineHealthOf([on("a")], runs, 100)).toEqual([{ routineId: "a", status: "failed", at: 40, consecutiveFailures: 3 }]);
    expect(routineHealthOf([on("a")], [...runs, run("a", "completed", 50)], 100)).toEqual([{ routineId: "a", status: "completed", at: 50, consecutiveFailures: 0 }]);
  });

  it("gives the same count however the rows are ordered, and to a process that has only just read them", () => {
    const runs = [run("a", "failed", 40), run("a", "completed", 10), run("a", "failed", 20)];
    expect(routineHealthOf([on("a")], runs, 100)).toEqual(routineHealthOf([on("a")], JSON.parse(JSON.stringify(runs)).reverse(), 100));
    expect(routineHealthOf([on("a")], runs, 100)[0]).toMatchObject({ consecutiveFailures: 2 });
  });

  it("neither counts a cancelled run nor lets it end the row, and ignores runs still going", () => {
    const runs = [run("a", "failed", 10), run("a", "cancelled", 20), run("a", "failed", 30), run("a", "running", 40, { finishedAt: undefined }), run("a", "queued", 50, { finishedAt: undefined })];
    expect(routineHealthOf([on("a")], runs, 100)).toEqual([{ routineId: "a", status: "failed", at: 30, consecutiveFailures: 2 }]);
  });

  it("leaves out a routine that is off or deleted, and keeps an outside trigger's runs", () => {
    const runs = [run("off", "failed", 10), run("gone", "failed", 20), run("hook", "failed", 30, { webhookId: "hook", triggerSource: "webhook" }), run("a", "completed", 40)];
    expect(routineHealthOf([on("a"), { id: "off", enabled: false }], runs, 100).map((health) => health.routineId)).toEqual(["a", "hook"]);
  });

  it("does not take a row that only counts skipped occurrences for a failure, unless the owner was told", () => {
    const counted = run("a", "missed", 30, { skipped: { count: 4, firstAt: 25, lastAt: 30, behind: "a-20" } });
    expect(routineHealthOf([on("a")], [run("a", "completed", 10), run("a", "failed", 20), counted], 100)).toEqual([{ routineId: "a", status: "failed", at: 20, consecutiveFailures: 1 }]);
    expect(routineHealthOf([on("a")], [run("a", "completed", 20), counted], 100)).toEqual([{ routineId: "a", status: "completed", at: 20, consecutiveFailures: 0 }]);
    expect(routineHealthOf([on("a")], [counted], 100)).toEqual([]);
    const told = { ...counted, skipped: { ...counted.skipped!, told: true as const } };
    expect(routineHealthOf([on("a")], [run("a", "failed", 20), told], 100)).toEqual([{ routineId: "a", status: "missed", at: 30, consecutiveFailures: 2 }]);
  });

  it("keeps the newest up to the cap, and says nothing of a routine's words", () => {
    const runs = Array.from({ length: 5 }, (_, index) => run(`r${index}`, "failed", index + 1));
    const health = routineHealthOf(runs.map((row) => on(row.routineId)), runs, 2);
    expect(health.map((row) => row.routineId)).toEqual(["r4", "r3"]);
    expect(JSON.stringify(health)).not.toMatch(/Planted/);
    expect(Object.keys(health[0]!).sort()).toEqual(["at", "consecutiveFailures", "routineId", "status"]);
  });
});
