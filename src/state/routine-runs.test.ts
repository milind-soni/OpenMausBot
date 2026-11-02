import { describe, expect, it } from "vitest";

import type { RoutineRun } from "@/lib/routines";
import { olderRunsSince, withOlderRoutineRuns } from "./routine-runs";

const run = (id: string, scheduledFor: number, status: RoutineRun["status"] = "completed") => ({ id, routineId: "r", scheduledFor, status }) as RoutineRun;

describe("older routine runs", () => {
  it("adds the runs a view loaded and keeps the app's newer copy of one it already holds", () => {
    const held = [run("a", 30, "running"), run("b", 20)];
    const merged = withOlderRoutineRuns(held, [run("a", 30, "queued"), run("c", 10)]);
    expect(merged.map((candidate) => [candidate.id, candidate.status])).toEqual([["a", "running"], ["b", "completed"], ["c", "completed"]]);
  });

  it("moves the window's start back only when the loaded range reaches it", () => {
    expect(olderRunsSince(100, { from: 40, to: 100 })).toBe(40);
    expect(olderRunsSince(100, { from: 40, to: 90 })).toBe(100);
    expect(olderRunsSince(100, {})).toBe(100);
    expect(olderRunsSince(null, { from: 40, to: 100 })).toBeNull();
  });
});
