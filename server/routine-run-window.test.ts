import { describe, expect, it } from "vitest";

import { appRunWindow, NEWEST_RUNS_PER_AUTOMATION, routineRunsFor } from "./routine-run-window.ts";
import type { RoutineRun } from "./routines.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 1);
const run = (id: string, routineId: string, daysAgo: number, status: RoutineRun["status"], extra: Partial<RoutineRun> = {}) =>
  ({ id, routineId, routineName: routineId, botId: "b", target: "bot", scheduledFor: NOW - daysAgo * DAY, status, manual: false, ...extra }) as RoutineRun;
const ids = (runs: readonly RoutineRun[]) => runs.map((candidate) => candidate.id);

describe("the app's run window", () => {
  it("keeps recent runs and, whatever their age, the ones a status, a badge or a panel reads", () => {
    const old = Array.from({ length: 20 }, (_, i) => run(`daily-${i}`, "daily", 30 + i, "completed"));
    const runs = [
      run("recent", "daily", 1, "completed"),
      ...old,
      run("waiting", "weekly", 60, "waiting"),
      run("unseen", "weekly", 61, "failed"),
      run("seen", "weekly", 62, "failed", { seenAt: NOW }),
      run("weekly-ok", "weekly", 63, "completed"),
      run("weekly-older", "weekly", 64, "completed"),
      ...Array.from({ length: 10 }, (_, i) => run(`weekly-${i}`, "weekly", 70 + i, "completed")),
    ];
    const kept = ids(appRunWindow(runs, NOW - 14 * DAY));
    expect(kept.filter((id) => id.startsWith("daily-"))).toHaveLength(NEWEST_RUNS_PER_AUTOMATION - 1);
    expect(kept).toEqual(expect.arrayContaining(["recent", "waiting", "unseen", "seen", "weekly-ok", "weekly-older"]));
    expect(kept).not.toContain("weekly-9");
  });

  it("reaches back past a run of failures to the last success, so the streak counts the same", () => {
    const runs = [
      ...Array.from({ length: 9 }, (_, i) => run(`fail-${i}`, "r", 20 + i, "failed", { seenAt: NOW })),
      run("cancelled", "r", 40, "cancelled"),
      run("ok", "r", 41, "completed"),
      run("older", "r", 42, "completed"),
    ];
    expect(ids(appRunWindow(runs, NOW - 14 * DAY))).toEqual(runs.slice(0, 11).map((candidate) => candidate.id));
  });

  it("answers a range, a thread, the window, or everything", () => {
    const runs = [run("a", "r", 1, "completed", { threadId: "t1" }), run("b", "r", 30, "completed")];
    const listRuns = (from?: number, to?: number) => runs.filter((candidate) => (from === undefined || candidate.scheduledFor >= from) && (to === undefined || candidate.scheduledFor <= to));
    expect(ids(routineRunsFor(listRuns, new URLSearchParams()))).toEqual(["a", "b"]);
    expect(ids(routineRunsFor(listRuns, new URLSearchParams({ from: String(NOW - 40 * DAY), to: String(NOW - 20 * DAY) })))).toEqual(["b"]);
    expect(ids(routineRunsFor(listRuns, new URLSearchParams({ thread: "t1" })))).toEqual(["a"]);
    expect(ids(routineRunsFor(listRuns, new URLSearchParams({ since: String(NOW - 7 * DAY) })))).toEqual(["a", "b"]);
  });
});
