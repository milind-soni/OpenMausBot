import { expect, it } from "vitest";

import { evictRuns } from "./routine-run-history.ts";
import type { RoutineRun } from "./routines.ts";

const run = (id: string, routineId: string, status: RoutineRun["status"] = "completed") => ({ id, routineId, status }) as RoutineRun;

it("drops the oldest ended rows of the routine that holds the most, never one that has not ended", () => {
  const runs = [run("daily-1", "daily"), run("busy-1", "busy", "running"), ...Array.from({ length: 6 }, (_, index) => run(`busy-${index + 2}`, "busy")), run("daily-2", "daily"), run("weekly-1", "weekly", "waiting")];
  evictRuns(runs, 7);
  expect(runs.map((row) => row.id)).toEqual(["daily-1", "busy-1", "busy-5", "busy-6", "busy-7", "daily-2", "weekly-1"]);
  evictRuns(runs, 7);
  expect(runs).toHaveLength(7);
});

it("stops when only rows that have not ended are left", () => {
  const runs = [run("a", "one", "queued"), run("b", "one", "running"), run("c", "two")];
  evictRuns(runs, 1);
  expect(runs.map((row) => row.id)).toEqual(["a", "b"]);
});
