import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { join } from "node:path";

import { RoutineManager, type RoutineCheckResult } from "../routines.ts";

const [dir, mode] = process.argv.slice(2);
let resolve!: (result: RoutineCheckResult) => void;
const pending = new Promise<RoutineCheckResult>((answer) => { resolve = answer; });
let now = Date.parse("2026-10-28T09:00:00Z");
const manager = new RoutineManager({
  file: join(dir!, "routines.json"), now: () => now,
  botState: () => "ready", createTask: () => ({ threadId: "fixture-thread" }),
  startTurn: async () => { assert.fail("A failed check must not start a turn"); },
  checks: { check: async () => pending, release: () => {}, settled: () => {} },
  emit: (event) => {
    if (mode === "scheduled" && event.kind === "routine" && (event.routine as { checkTrouble?: string }).checkTrouble) {
      throw new Error("fixture receipt notification failed");
    }
  },
});
const routine = manager.create({
  name: "Fixture checks", prompt: "Check the fixture inbox", botId: "fixture-bot", checks: ["mail"],
  schedule: { type: "interval", everyMinutes: 15, anchorAt: now + 15 * 60_000 },
});
const storage = manager as unknown as { save(): void };
const save = storage.save.bind(manager);
storage.save = () => {
  if (manager.listRuns().some((run) => run.status === "failed")) {
    throw Object.assign(new Error("fixture disk full"), { code: "ENOSPC" });
  }
  save();
};
if (mode === "manual") manager.runNow(routine.id);
else now += 15 * 60_000;
await manager.tick();
resolve({ trouble: "Couldn't read Gmail. Reconnect it in Connected apps." });
await setImmediate();
assert.equal(manager.listRoutines()[0]!.checkTrouble, "Couldn't read Gmail. Reconnect it in Connected apps.");
if (mode === "manual") {
  const disk = JSON.parse(readFileSync(join(dir!, "routines.json"), "utf8"));
  assert.equal(disk.runs[0].status, "queued");
  manager.close();
  const retry = new RoutineManager({
    file: join(dir!, "routines.json"), botState: () => "ready", createTask: () => null,
    startTurn: async () => { assert.fail("A failed check must not start a turn"); },
    checks: { check: async () => pending, release: () => {}, settled: () => {} },
  });
  await retry.tick();
  await setImmediate();
  assert.equal(retry.listRuns()[0]!.status, "failed");
  retry.close();
  const restored = new RoutineManager({ file: join(dir!, "routines.json"), botState: () => "ready", createTask: () => null, startTurn: async () => {} });
  assert.equal(restored.listRuns()[0]!.status, "failed");
} else assert.deepEqual(manager.listRuns(), []);
manager.close();
console.log("fixture survived");
