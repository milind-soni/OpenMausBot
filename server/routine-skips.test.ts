import { describe, expect, it } from "vitest";

import { ROUTINE_DEFERRAL_NOTICE_MS } from "./routine-execution.ts";
import { blockingRun, loadSkips, recordSkip } from "./routine-skips.ts";
import type { RoutineRun } from "./routines.ts";

const MINUTE = 60_000;
const run = (id: string, status: RoutineRun["status"], more: Partial<RoutineRun> = {}): RoutineRun => ({
  id, routineId: "r", routineName: "Check", target: "bot", botId: "bot-1", runOn: "maus", scheduledFor: 0, status, manual: false, createdAt: 0, ...more,
});

describe("the run an occurrence is skipped behind", () => {
  it("is the routine's own run that waits, else the one working, else the one not started", () => {
    expect(blockingRun([run("other", "running", { routineId: "x" }), run("done", "completed")], "r")).toBeUndefined();
    expect(blockingRun([run("q", "queued")], "r")).toMatchObject({ run: { id: "q" }, why: "routines.server.part.notStarted" });
    expect(blockingRun([run("q", "queued"), run("w", "running", { startedAt: 5 })], "r")).toMatchObject({ run: { id: "w" }, why: "routines.server.part.stillRunning" });
    expect(blockingRun([run("w", "running"), run("p", "waiting", { waitingSince: 7 })], "r")).toEqual({ run: expect.objectContaining({ id: "p" }), why: "routines.server.part.stillWaiting", waitingSince: 7 });
  });
});

describe("occurrences skipped for one cause", () => {
  it("share one missed row that counts them and keeps the first and last time", () => {
    const runs: RoutineRun[] = [];
    const make = () => { const row = run(`row-${runs.length}`, "queued"); runs.push(row); return row; };
    const cause = { behind: "blocker", why: "routines.server.part.stillRunning" as const };
    expect(recordSkip(runs, make, cause, 1 * MINUTE, 1 * MINUTE)).toMatchObject({ added: true, tell: false });
    expect(runs).toEqual([expect.objectContaining({ status: "missed", finishedAt: MINUTE, seenAt: MINUTE, error: "Skipped because the previous run of this routine is still running",
      errorCode: "routines.server.skippedOne", errorParams: { why: "routines.server.part.stillRunning" }, skipped: { count: 1, firstAt: MINUTE, lastAt: MINUTE, behind: "blocker" } })]);
    for (let minute = 2; minute <= 180; minute += 1) expect(recordSkip(runs, make, cause, minute * MINUTE, minute * MINUTE).added).toBe(false);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ finishedAt: 180 * MINUTE, error: "Skipped 180 scheduled runs because the previous run of this routine is still running",
      errorCode: "routines.server.skippedMany", errorParams: { count: 180, why: "routines.server.part.stillRunning" }, skipped: { count: 180, firstAt: MINUTE, lastAt: 180 * MINUTE } });
  });

  it("start a new row for another cause", () => {
    const runs: RoutineRun[] = [];
    const make = () => { const row = run(`row-${runs.length}`, "queued"); runs.push(row); return row; };
    recordSkip(runs, make, { behind: "first", why: "routines.server.part.stillRunning" }, 1, 1);
    recordSkip(runs, make, { behind: "no-start:first", why: "routines.server.part.computerNoStart" }, 2, 2);
    expect(runs.map((row) => [row.skipped?.behind, row.error])).toEqual([
      ["first", "Skipped because the previous run of this routine is still running"],
      ["no-start:first", "Skipped because its cloud desktop has not started, so its next tries are spaced out"],
    ]);
  });

  it("tell the owner once per waiting run, when it has waited a notice window, and show the row as unseen from then", () => {
    const runs: RoutineRun[] = [];
    const make = () => { const row = run(`row-${runs.length}`, "queued"); runs.push(row); return row; };
    const cause = { behind: "waiter", why: "routines.server.part.stillWaiting" as const, waitingSince: 0 };
    expect(recordSkip(runs, make, cause, ROUTINE_DEFERRAL_NOTICE_MS - 1, 10).tell).toBe(false);
    expect(runs[0]!.seenAt).toBe(10);
    expect(recordSkip(runs, make, cause, ROUTINE_DEFERRAL_NOTICE_MS, 20).tell).toBe(true);
    expect(runs[0]).not.toHaveProperty("seenAt");
    expect(runs[0]!.skipped).toMatchObject({ count: 2, told: true });
    expect(recordSkip(runs, make, cause, ROUTINE_DEFERRAL_NOTICE_MS * 2, 30).tell).toBe(false);
    expect(runs).toHaveLength(1);
  });

  it("count with an occurrence the ones that came due before it while nothing could look", () => {
    const runs: RoutineRun[] = [];
    const make = () => { const row = run(`row-${runs.length}`, "queued"); runs.push(row); return row; };
    const cause = { behind: "worker", why: "routines.server.part.stillRunning" as const };
    recordSkip(runs, make, cause, 40, 45, { count: 3, scheduledFor: 10 });
    expect(runs[0]).toMatchObject({ error: "Skipped 4 scheduled runs because the previous run of this routine is still running", skipped: { count: 4, firstAt: 10, lastAt: 40 } });
    recordSkip(runs, make, cause, 70, 75, { count: 2, scheduledFor: 50 });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.skipped).toMatchObject({ count: 7, firstAt: 10, lastAt: 70 });
  });
});

describe("skip counts read back from routines.json", () => {
  it("keep a whole record and drop anything out of shape", () => {
    expect(loadSkips({ count: 3, firstAt: 1, lastAt: 9, behind: "no-start:abc-1", told: true, extra: "x" })).toEqual({ count: 3, firstAt: 1, lastAt: 9, behind: "no-start:abc-1", told: true });
    expect(loadSkips({ count: 3, firstAt: 1, lastAt: 9, behind: "abc" })).toEqual({ count: 3, firstAt: 1, lastAt: 9, behind: "abc" });
    for (const bad of [undefined, null, "x", {}, { count: 0, firstAt: 1, lastAt: 1, behind: "a" }, { count: 1.5, firstAt: 1, lastAt: 1, behind: "a" }, { count: 1, firstAt: 1, lastAt: 1, behind: "a b" }, { count: 1, firstAt: "1", lastAt: 1, behind: "a" }]) {
      expect(loadSkips(bad)).toBeUndefined();
    }
  });
});
