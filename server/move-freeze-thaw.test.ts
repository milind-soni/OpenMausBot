import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { CalendarCallManager } from "./calendar-calls.ts";
import { createMoveFreeze, ENDED_REFUSAL, switchAutomationsOff, type MoveAutomations } from "./move-freeze.ts";
import { RoutineManager } from "./routines.ts";
import { createMoveFreezeRoutes } from "./routes/move-freeze.ts";
import { WebhookManager } from "./webhooks.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const HOUR = 3_600_000;

/**
 * A computer's copy frozen at the move, with real schedulers held by the freeze and spies on what they start: a routine
 * that runs at every start, one due now, a scheduled call due now, a webhook and an app event, all on.
 */
function frozenCopy({ exportOnly = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-thaw-"));
  dirs.push(dir);
  let clock = Date.UTC(2026, 9, 20, 8, 0);
  const now = () => clock;
  const turns: string[] = [], kickoffs: string[] = [];
  const routines = new RoutineManager({ file: join(dir, "routines.json"), now, botState: () => "ready", createTask: () => ({ threadId: "t-run" }),
    startTurn: async (_bot, _thread, prompt) => { turns.push(prompt); } });
  const calls = new CalendarCallManager({ file: join(dir, "calendar-calls.json"), now, botExists: () => true, onDue: (call) => { kickoffs.push(call.name); } });
  const webhooks = new WebhookManager({ file: join(dir, "webhooks.json"), now, botState: () => "ready", enqueue: () => ({ runId: "x" }) } as never);
  const startup = routines.create({ name: "At every start", prompt: "Say hello.", botId: "b1", runOnStartup: true,
    schedule: { type: "interval", everyMinutes: 1_440, anchorAt: clock + 2 * 24 * HOUR } });
  const morning = routines.create({ name: "Morning", prompt: "Report.", botId: "b1", schedule: { type: "interval", everyMinutes: 1_440, anchorAt: clock + 30 * 60_000 } });
  const paused = routines.create({ name: "Paused", prompt: "Wait.", botId: "b1", enabled: false, schedule: { type: "daily", time: "10:00", weekdays: [1] } });
  const call = calls.create({ name: "Sync", botIds: ["b1"], schedule: { type: "once", at: clock + 30 * 60_000 }, durationMinutes: 120 });
  const webhook = webhooks.create({ name: "Orders", prompt: "File it.", botId: "b1" }).webhook;
  const appEvents = { switched: [] as Array<[string, unknown]>, list: () => [{ id: "e1", enabled: true }], update: async (id: string, patch: unknown) => { appEvents.switched.push([id, patch]); return null; } };
  const freeze = createMoveFreeze({ dataDir: dir, exportOnly });
  freeze.freeze("https://omb-t-1.fly.dev");
  freeze.hold(() => routines.start(), () => routines.stop());
  freeze.hold(() => calls.start(), () => calls.stop());
  // Frozen past both times: the morning routine and the call are due the moment the schedulers start.
  clock += 75 * 60_000;
  const automations = { routines: () => routines, calls: () => calls, webhooks: () => webhooks, appEvents: () => appEvents } as unknown as MoveAutomations;
  const route = createMoveFreezeRoutes({ freeze, busy: () => null, restart() {}, automationsOff: () => switchAutomationsOff(automations) });
  const lift = async (body: unknown) => {
    let answered: { status: number; body: any } | undefined;
    await route({ path: "/api/move/freeze", method: "DELETE", url: new URL("http://127.0.0.1/api/move/freeze"), req: {} as never, res: {} as never,
      auth: { kind: "loopback", scopes: ["admin"] } as never, json: (_res: unknown, status: number, value: unknown) => { answered = { status, body: value }; }, readBody: async () => body } as never);
    return answered!;
  };
  /** Whatever the schedulers would start now has started. */
  const settle = async () => { for (let pass = 0; pass < 3; pass++) { await routines.tick(); await calls.tick(); await new Promise((resolve) => setTimeout(resolve, 20)); } };
  const close = () => { routines.close(); calls.stop(); };
  return { freeze, routines, calls, webhooks, appEvents, turns, kickoffs, lift, settle, close, ids: { startup: startup.id, morning: morning.id, paused: paused.id, call: call.id, webhook: webhook.id } };
}

it("lifted while another computer is home now, every automation is switched off first, so none of them runs; lifted as it was, what is due runs at once", async () => {
  const asItWas = frozenCopy();
  try {
    expect(await asItWas.lift({})).toEqual({ status: 200, body: { frozen: false } });
    await asItWas.settle();
    expect(asItWas.turns.map((prompt) => prompt.split("\n").at(-1)).sort(), "the scheduler spies see the runs a thaw starts").toEqual(["Report.", "Say hello."]);
    expect(asItWas.kickoffs).toEqual(["Sync"]);
    expect(asItWas.appEvents.switched).toEqual([]);
  } finally { asItWas.close(); }
  const copy = frozenCopy();
  try {
    expect(await copy.lift({ automations: "off" })).toEqual({ status: 200, body: { frozen: false } });
    expect(copy.freeze.frozen()).toBe(false);
    await copy.settle();
    expect(copy.turns, "no routine ran").toEqual([]);
    expect(copy.kickoffs, "no call started").toEqual([]);
    expect(copy.routines.listRoutines().map((routine) => [routine.name, routine.enabled]).sort()).toEqual([["At every start", false], ["Morning", false], ["Paused", false]]);
    expect(copy.routines.listRuns()).toEqual([]);
    expect(copy.calls.list().map((call) => call.nextRunAt)).toEqual([null]);
    expect(copy.webhooks.list().map((webhook) => webhook.enabled)).toEqual([false]);
    expect(copy.appEvents.switched).toEqual([["e1", { enabled: false }]]);
    // Each stays where the person can switch it on by hand.
    expect(copy.routines.update(copy.ids.morning, { enabled: true })?.enabled).toBe(true);
    expect(copy.calls.update(copy.ids.call, {}).nextRunAt).not.toBeNull();
  } finally { copy.close(); }
});

it("an ended Cloud open for its owner's export is never lifted, and switches nothing off", async () => {
  const copy = frozenCopy({ exportOnly: true });
  try {
    expect(await copy.lift({ automations: "off" })).toEqual({ status: 409, body: { error: ENDED_REFUSAL } });
    expect(copy.freeze.frozen()).toBe(true);
    expect(copy.routines.listRoutines().filter((routine) => routine.enabled).map((routine) => routine.name).sort()).toEqual(["At every start", "Morning"]);
    expect(copy.appEvents.switched).toEqual([]);
    expect(await copy.lift({ automations: "on" }), "only off is understood").toMatchObject({ status: 400 });
  } finally { copy.close(); }
});
