import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { holdCauses, shiftHolds } from "./routine-holds.ts";
import { RoutineManager, type RoutineManagerOptions } from "./routines.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const START = Date.parse("2026-10-30T06:00:00Z");
/** Lets a scheduler pass started in the background finish first. */
const settled = () => new Promise((resolve) => setImmediate(resolve));
const HOUR = 60 * 60_000;

function harness(file?: string) {
  let now = START;
  let task = 0;
  const started: string[] = [];
  const emitted: Array<Record<string, unknown>> = [];
  if (!file) {
    const dir = mkdtempSync(join(tmpdir(), "omb-routine-holds-"));
    dirs.push(dir);
    file = join(dir, "routines.json");
  }
  const options: RoutineManagerOptions = {
    file, now: () => now, emit: (payload) => emitted.push(payload), botState: () => "ready", goalState: () => "ready",
    createTask: () => ({ threadId: `thread-${++task}` }),
    startTurn: async (_botId, threadId) => { started.push(threadId); },
  };
  const manager = new RoutineManager(options);
  const hourly = (name: string, enabled = true) => manager.create({ name, prompt: `Do ${name}`, botId: "maus-1", enabled,
    schedule: { type: "interval", everyMinutes: 60, anchorAt: START + HOUR } });
  const routine = (id: string) => manager.listRoutines().find((candidate) => candidate.id === id)!;
  return { manager, file, started, emitted, hourly, routine, setNow: (at: number) => { now = at; }, now: () => now };
}

describe("why routines wait while their owner has left", () => {
  it("keeps the causes in one order, each once, and ignores anything else", () => {
    expect(holdCauses(["no_connections", "plan_cancelled", "no_connections", "bogus"])).toEqual(["plan_cancelled", "no_connections"]);
    expect(holdCauses("no_engine")).toEqual([]);
  });

  it("holds the routines that are on for the first cause that began, and frees each once no cause holds it", () => {
    const on = { enabled: true } as { enabled: boolean; heldFor?: "no_engine" | "no_connections" | "plan_cancelled" };
    const off = { enabled: false } as typeof on;
    expect(shiftHolds([on, off], [], ["no_engine", "no_connections"])).toMatchObject({ paused: [on], resumed: [], began: ["no_engine", "no_connections"] });
    expect(on.heldFor).toBe("no_engine");
    expect(off.heldFor).toBeUndefined();
    // Its cause ended while another still holds: it waits on that one.
    expect(shiftHolds([on], ["no_engine", "no_connections"], ["no_connections"])).toMatchObject({ paused: [], resumed: [] });
    expect(on.heldFor).toBe("no_connections");
    expect(shiftHolds([on], ["no_connections"], [])).toMatchObject({ paused: [], resumed: [on] });
    expect(on.heldFor).toBeUndefined();
  });
});

describe("routines pause while their owner has left, and come back by themselves", () => {
  it("turns off every routine that is on, cancels its queued run, and the list says why; nothing runs while it waits", async () => {
    const h = harness();
    const daily = h.hourly("Clarity export");
    const offAlready = h.hourly("Weekly digest", false);
    const queued = h.manager.runNow(daily.id)!;
    expect(queued.status).toBe("queued");

    expect(h.manager.holdFor(["no_engine"])).toEqual(["no_engine"]);
    expect(h.routine(daily.id)).toMatchObject({ enabled: false, heldFor: "no_engine", nextRunAt: null });
    expect(h.routine(offAlready.id).heldFor).toBeUndefined();
    expect(h.manager.listRuns().find((run) => run.id === queued.id)).toMatchObject({ status: "cancelled", error: "The routine was paused before this run started" });
    expect(h.emitted.some((frame) => frame.kind === "routine" && (frame.routine as { heldFor?: string })?.heldFor === "no_engine")).toBe(true);

    h.setNow(START + 5 * HOUR);
    await settled();
    await h.manager.tick();
    expect(h.started).toEqual([]);
    expect(h.manager.listRuns().filter((run) => run.status === "failed" || run.status === "missed")).toEqual([]);
    // The same causes again change nothing and pause nothing twice.
    expect(h.manager.holdFor(["no_engine"])).toEqual([]);
  });

  it("turns them back on from now once nothing holds them, without the runs they skipped", async () => {
    const h = harness();
    const daily = h.hourly("Clarity export");
    h.manager.holdFor(["plan_cancelled"]);
    h.setNow(START + 5 * HOUR + 10 * 60_000);
    expect(h.manager.holdFor([])).toEqual([]);
    expect(h.routine(daily.id)).toMatchObject({ enabled: true, nextRunAt: START + 6 * HOUR });
    expect(h.routine(daily.id).heldFor).toBeUndefined();
    await settled();
    await h.manager.tick();
    expect(h.started).toEqual([]);
    h.setNow(START + 6 * HOUR);
    await h.manager.tick();
    expect(h.started).toHaveLength(1);
  });

  it("waits until every cause has ended, and says nothing new for a cause that paused nothing", () => {
    const h = harness();
    const daily = h.hourly("Clarity export");
    h.manager.holdFor(["no_engine"]);
    expect(h.manager.holdFor(["no_engine", "no_connections"])).toEqual([]);
    expect(h.manager.holdFor(["no_connections"])).toEqual([]);
    expect(h.routine(daily.id)).toMatchObject({ enabled: false, heldFor: "no_connections" });
    h.manager.holdFor([]);
    expect(h.routine(daily.id)).toMatchObject({ enabled: true });
  });

  it("keeps the person's own choice: a routine turned on or off by hand is never paused or resumed for that cause", () => {
    const h = harness();
    const turnedOn = h.hourly("Clarity export");
    const turnedOff = h.hourly("Inbox sweep");
    const offBefore = h.hourly("Old report", false);
    h.manager.holdFor(["plan_cancelled"]);
    h.manager.update(turnedOn.id, { enabled: true });
    h.manager.update(turnedOff.id, { enabled: false });
    expect(h.routine(turnedOn.id)).toMatchObject({ enabled: true });
    expect(h.routine(turnedOn.id).heldFor).toBeUndefined();
    expect(h.routine(turnedOff.id).heldFor).toBeUndefined();
    h.manager.holdFor([]);
    expect(h.routine(turnedOn.id).enabled).toBe(true);
    expect(h.routine(turnedOff.id).enabled).toBe(false);
    expect(h.routine(offBefore.id).enabled).toBe(false);
  });

  it("never turns back on a room's routine whose room was deleted while it waited", () => {
    const h = harness();
    const goal = h.manager.create({ name: "Weekly plan", prompt: "Plan the week", botId: "maus-1", target: "room-goal", groupId: "room-1",
      schedule: { type: "interval", everyMinutes: 60, anchorAt: START + HOUR } });
    h.manager.holdFor(["no_engine"]);
    h.manager.disableForGroup("room-1");
    expect(h.routine(goal.id).heldFor).toBeUndefined();
    h.manager.holdFor([]);
    expect(h.routine(goal.id).enabled).toBe(false);
  });

  it("leaves a one-time run whose time passed while it waited over, never late", () => {
    const h = harness();
    const once = h.manager.create({ name: "Send the recap", prompt: "Send it", botId: "maus-1", schedule: { type: "once", at: START + HOUR } });
    h.manager.holdFor(["no_engine"]);
    h.setNow(START + 3 * HOUR);
    h.manager.holdFor([]);
    expect(h.routine(once.id)).toMatchObject({ enabled: false, nextRunAt: null });
    expect(h.routine(once.id).heldFor).toBeUndefined();
  });

  it("keeps what holds them across a restart, so the same causes pause nothing twice and a release still turns them on", () => {
    const h = harness();
    const daily = h.hourly("Clarity export");
    h.manager.holdFor(["no_engine"]);
    expect(JSON.parse(readFileSync(h.file, "utf8")).holds).toEqual(["no_engine"]);
    const again = harness(h.file);
    expect(again.routine(daily.id)).toMatchObject({ enabled: false, heldFor: "no_engine" });
    expect(again.manager.holdFor(["no_engine"])).toEqual([]);
    again.manager.holdFor([]);
    expect(again.routine(daily.id).enabled).toBe(true);
  });
});
