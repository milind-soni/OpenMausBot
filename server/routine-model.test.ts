import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { modelSwitchNeedsAsk, type ApprovalMode } from "../shared/approval-mode.ts";
import type { ModelSelection } from "../shared/wire.ts";
import { ROUTINE_MODEL_PERMISSIONS, routineModelRefusal, routineThreadModel, type RoutineModelChecks } from "./routine-input.ts";
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

  it("refuses a model on a limit-reset routine, which stays on the model of the conversation it continues", () => {
    const { routines } = manager();
    const schedule = { type: "limit_reset" as const, engine: "claude", repeat: "once" as const };
    expect(() => routines.create({ name: "Continue", prompt: "Carry on", botId: "maus-1", schedule, modelSelection: HAIKU })).toThrow("continues its conversation");
    const routine = routines.create({ name: "Continue", prompt: "Carry on", botId: "maus-1", schedule });
    expect(() => routines.update(routine.id, { modelSelection: HAIKU })).toThrow("continues its conversation");
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

describe("a routine's model and its bot's permissions", () => {
  const DRIVERS: Record<string, string> = { claude: "claudeAgent", codex: "codex", gemini: "geminiAgent", pi: "pi" };
  const CODEX = { instanceId: "codex", model: "gpt-5-codex" };
  const bots: Record<string, { modelSelection: ModelSelection; approvalMode: ApprovalMode }> = {
    custom: { modelSelection: CODEX, approvalMode: "custom" },
    edits: { modelSelection: HAIKU, approvalMode: "edits" },
    full: { modelSelection: CODEX, approvalMode: "full" },
  };
  const checks: RoutineModelChecks = {
    check: (raw) => ({ ok: true, selection: raw as ModelSelection }),
    bot: (botId) => bots[botId],
    engineSwitchNeedsAsk: (mode, from, to) => modelSwitchNeedsAsk(mode, DRIVERS[from.instanceId], DRIVERS[to.instanceId]),
  };
  const refusal = { status: 400, error: ROUTINE_MODEL_PERMISSIONS };

  it("refuses a model on another engine that the bot's permission level can't move to, as a bot's own model change is", () => {
    expect(routineModelRefusal({ botId: "custom", modelSelection: HAIKU }, checks)).toEqual(refusal);
    expect(routineModelRefusal({ botId: "edits", modelSelection: { instanceId: "pi", model: "pi-1" } }, checks)).toEqual(refusal);
  });

  it("keeps a model on the bot's own engine, or on any engine the permission level carries to", () => {
    expect(routineModelRefusal({ botId: "custom", modelSelection: { ...CODEX, model: "gpt-5-mini" } }, checks)).toBeNull();
    expect(routineModelRefusal({ botId: "edits", modelSelection: { instanceId: "gemini", model: "gemini-flash" } }, checks)).toBeNull();
    expect(routineModelRefusal({ botId: "full", modelSelection: HAIKU }, checks)).toBeNull();
  });

  it("checks the routine's model again when an edit moves it to another bot, and not when the edit drops it", () => {
    const existing = { botId: "full", modelSelection: HAIKU };
    expect(routineModelRefusal({ botId: "custom" }, checks, existing)).toEqual(refusal);
    expect(routineModelRefusal({ botId: "custom", modelSelection: null }, checks, existing)).toBeNull();
    expect(routineModelRefusal({ prompt: "Sweep twice" }, checks, existing)).toBeNull();
  });

  it("opens a run on the bot's model once the bot's permissions no longer let the routine's model through", () => {
    expect(routineThreadModel({ botId: "full", modelSelection: HAIKU }, checks)).toEqual(HAIKU);
    expect(routineThreadModel({ botId: "custom", modelSelection: HAIKU }, checks)).toBeUndefined();
    expect(routineThreadModel({ botId: "custom" }, checks)).toBeUndefined();
  });
});
