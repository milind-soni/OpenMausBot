import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RoutineManager, type RoutineManagerOptions } from "./routines.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const START = new Date(2026, 7, 17, 8, 0, 0).getTime();
const HAIKU = { instanceId: "claude", model: "claude-haiku-4-5" };

function manager() {
  const dir = mkdtempSync(join(tmpdir(), "omb-routine-model-"));
  dirs.push(dir);
  const options: RoutineManagerOptions = {
    file: join(dir, "routines.json"),
    now: () => START,
    botState: () => "ready",
    createTask: () => ({ threadId: "thread-1" }),
    startTurn: async () => {},
  };
  return { options, routines: new RoutineManager(options) };
}

const daily = { type: "daily" as const, time: "09:00", weekdays: [1] };

describe("a routine's own model", () => {
  it("keeps the model it was given across an edit and a restart, and drops it on null", () => {
    const { options, routines } = manager();
    const routine = routines.create({ name: "Inbox sweep", prompt: "Sweep the inbox", botId: "maus-1", schedule: daily, modelSelection: { ...HAIKU, effort: "low" } });
    expect(routine.modelSelection).toEqual({ ...HAIKU, effort: "low" });
    expect(routines.update(routine.id, { prompt: "Sweep the inbox twice" })?.modelSelection).toEqual({ ...HAIKU, effort: "low" });
    expect(new RoutineManager(options).listRoutines()[0]!.modelSelection).toEqual({ ...HAIKU, effort: "low" });
    expect(routines.update(routine.id, { modelSelection: null })?.modelSelection).toBeUndefined();
    expect(new RoutineManager(options).listRoutines()[0]).not.toHaveProperty("modelSelection");
  });

  it("refuses a model with no engine or model id, with both an effort and a variant, or on a room goal", () => {
    const { routines } = manager();
    const create = (modelSelection: unknown, target: "bot" | "room-goal" = "bot") =>
      () => routines.create({ name: "Inbox sweep", prompt: "Sweep the inbox", botId: "maus-1", target, schedule: daily, modelSelection } as never);
    expect(create({ model: "claude-haiku-4-5" })).toThrow(/Choose a model/);
    expect(create({ instanceId: "claude", model: " " })).toThrow(/Choose a model/);
    expect(create({ ...HAIKU, effort: "low", variant: "fast" })).toThrow(/Choose a model/);
    expect(create(HAIKU, "room-goal")).toThrow(/Room goals run on their bots' own models/);
    expect(routines.listRoutines()).toEqual([]);
  });
});
