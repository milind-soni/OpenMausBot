import { expect, it } from "vitest";

import { COUNT_STEP_CAP_MS } from "./routine-bounds.ts";
import { RunWatch, TURN_GONE_MS } from "./routine-run-watch.ts";
import type { RoutineRun } from "./routines.ts";

const run = (id: string, more: Partial<RoutineRun> = {}): RoutineRun => ({
  id, routineId: id, routineName: "Check", prompt: "Check", target: "bot", botId: "bot-1", runOn: "maus",
  scheduledFor: 1, createdAt: 1, startedAt: 1, threadId: `thread-${id}`, status: "running", manual: false, ...more,
});

it("keeps event sweeping proportional to the number of runs and conversations", () => {
  function reads(count: number): number {
    let looked = 0;
    const runs = Array.from({ length: count }, (_, i) => {
      const row = run(String(i));
      Object.defineProperty(row, "threadId", { get: () => { looked++; return `thread-${i}`; } });
      return row;
    });
    const watch = new RunWatch(() => false);
    for (let i = 0; i < count; i++) watch.seen(`thread-${i}`);
    expect(watch.lost(runs, 1)).toEqual([]);
    return looked;
  }
  // Doubling the rows and their event histories must not quadruple the scan work.
  expect(reads(200)).toBeLessThan(reads(100) * 3);
});

it("retains a live thread's events while forgetting ended runs and absent conversations", () => {
  const watch = new RunWatch(() => false);
  const working = run("working"), ended = run("ended", { status: "completed" });
  const runs = [ended, working];
  watch.seen(ended.threadId!);
  watch.seen("not-a-routine");
  expect(watch.lost(runs, 1)).toEqual([]);
  let now = 1;
  for (; now < TURN_GONE_MS - COUNT_STEP_CAP_MS; now += COUNT_STEP_CAP_MS) expect(watch.lost(runs, now)).toEqual([]);
  watch.seen(working.threadId!);
  expect(watch.lost(runs, now)).toEqual([]);
  for (let elapsed = COUNT_STEP_CAP_MS; elapsed < TURN_GONE_MS; elapsed += COUNT_STEP_CAP_MS) {
    expect(watch.lost(runs, now + elapsed)).toEqual([]);
  }
  expect(watch.lost(runs, now + TURN_GONE_MS)).toEqual([working]);
  expect(watch.lost([], now + TURN_GONE_MS)).toEqual([]);
  expect(watch.dueAt([], now)).toBeNull();
});
