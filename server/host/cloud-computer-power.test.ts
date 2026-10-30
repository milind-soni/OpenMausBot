import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { PLACE_EN } from "../../shared/place-view.ts";
import type { ManagedBoatInventory } from "../boat.ts";
import type { BotRecord } from "../store.ts";

const fake = vi.hoisted(() => ({
  configured: true,
  /** The provider's current state of each owner's computer; absent means it has none. */
  states: new Map<string, string>(),
  deleting: new Set<string>(),
  creating: new Set<string>(),
  findBoat: null as unknown as Mock<(...args: any[]) => any>,
  sleepBoat: null as unknown as Mock<(...args: any[]) => any>,
  readyBoat: null as unknown as Mock<(...args: any[]) => any>,
  provisionBoat: null as unknown as Mock<(...args: any[]) => any>,
  listManagedBoats: null as unknown as Mock<(...args: any[]) => any>,
}));

vi.mock("../boat.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../boat.ts")>(),
  boatConfigured: () => fake.configured,
  findBoat: (...args: unknown[]) => fake.findBoat(...args),
  sleepBoat: (...args: unknown[]) => fake.sleepBoat(...args),
  readyBoat: (...args: unknown[]) => fake.readyBoat(...args),
  provisionBoat: (...args: unknown[]) => fake.provisionBoat(...args),
  listManagedBoats: (...args: unknown[]) => fake.listManagedBoats(...args),
}));
vi.mock("../boat-delete-journal.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../boat-delete-journal.ts")>(),
  hasPendingBoatDeletionForBot: (botId: string) => fake.deleting.has(botId),
}));
vi.mock("../boat-create-idempotency.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../boat-create-idempotency.ts")>(),
  boatCreateRecoverySnapshot: () => [...fake.creating].map(botId => ({ botId, resolved: false, boxId: null })),
}));

const { CLOUD_COMPUTER_IDLE_MS, ROUTINE_DUE_SOON_MS, createCloudComputerPower } = await import("./cloud-computer-power.ts");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const boxIdOf = (owner: string) => `bx_${owner}`;
const turn = (threadId: string, generation = "g1") => ({ threadId, generation });
const bot = (id: string) => ({ id, name: id }) as BotRecord;

describe("cloud computer power", () => {
  let busy: Set<string>;
  let claims: string[];
  let refuseClaim: boolean;
  let logs: string[];
  let broadcasts: Record<string, unknown>[];
  let routines: { botId: string; runOn: "maus" | "cloud"; enabled: boolean; nextRunAt: number | null }[];
  /** Which cloud computer each bot's routine turns use; a bot left out uses none. */
  let computers: Map<string, string>;
  let power: ReturnType<typeof createCloudComputerPower>;

  const sleeps = () => fake.sleepBoat.mock.calls.map(([, owner]) => owner as string);

  beforeEach(() => {
    vi.useFakeTimers();
    fake.configured = true;
    fake.states = new Map();
    fake.deleting = new Set();
    fake.creating = new Set();
    fake.findBoat = vi.fn(async (_cfg, owner: string) => fake.states.has(owner) ? { id: boxIdOf(owner), state: fake.states.get(owner) } : null);
    fake.sleepBoat = vi.fn(async (_cfg, owner: string) => { fake.states.set(owner, "archived"); return { ok: true }; });
    fake.readyBoat = vi.fn(async (_cfg, owner: string) => { fake.states.set(owner, "ready"); return { id: boxIdOf(owner), state: "ready" }; });
    fake.provisionBoat = vi.fn(async (_cfg, owner: string) => { fake.states.set(owner, "ready"); });
    fake.listManagedBoats = vi.fn(async (): Promise<ManagedBoatInventory> => ({ configured: true, available: true, problem: null, instances: [] }));
    busy = new Set();
    claims = [];
    refuseClaim = false;
    logs = [];
    broadcasts = [];
    routines = [];
    computers = new Map();
    power = createCloudComputerPower({
      cfg: { box: { token: "box_test" } },
      busy: owner => busy.has(owner),
      claim: owner => {
        if (refuseClaim) throw new Error("this bot's cloud computer is being changed");
        claims.push(`claim ${owner}`);
        return () => claims.push(`release ${owner}`);
      },
      owners: () => [],
      routines: () => routines,
      routineComputer: routine => computers.get(routine.botId) ?? null,
      broadcast: payload => broadcasts.push(payload),
      log: line => logs.push(line),
    });
  });

  afterEach(() => {
    power.close();
    vi.useRealTimers();
  });

  it("keeps the window in one constant: ten minutes, as the computer's status line says", () => {
    expect(CLOUD_COMPUTER_IDLE_MS).toBe(10 * MINUTE);
    expect(PLACE_EN["place.view.ccOn.line"]).toContain(`after ${CLOUD_COMPUTER_IDLE_MS / MINUTE} minutes without use`);
  });

  it("puts a computer to sleep once it has been idle for ten minutes, not before", async () => {
    fake.states.set("bot-a", "ready");
    power.used("bot-a");
    await vi.advanceTimersByTimeAsync(10 * MINUTE - 1);
    expect(fake.findBoat).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sleeps()).toEqual(["bot-a"]);
    expect(claims).toEqual(["claim bot-a", "release bot-a"]);
    expect(logs).toEqual(["cloud computer bot-a: asleep after 600s idle"]);
  });

  it("counts the window from the end of a turn, however long the turn ran", async () => {
    fake.states.set("bot-a", "ready");
    power.attached(turn("t1"), "bot-a");
    busy.add("bot-a");
    await vi.advanceTimersByTimeAsync(45 * MINUTE);
    expect(fake.findBoat).not.toHaveBeenCalled();
    busy.delete("bot-a");
    power.released(turn("t1"));
    await vi.advanceTimersByTimeAsync(10 * MINUTE - 1);
    expect(sleeps()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sleeps()).toEqual(["bot-a"]);
  });

  it("an older generation of the thread settling does not end a newer turn's hold", async () => {
    fake.states.set("bot-a", "ready");
    power.attached(turn("t1", "g2"), "bot-a");
    power.released(turn("t1", "g1"));
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    power.released(turn("t1", "g2"));
    await vi.advanceTimersByTimeAsync(10 * MINUTE - 1);
    expect(sleeps()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sleeps()).toEqual(["bot-a"]);
  });

  it("a routine run or a person's control postpones it for as long as it lasts", async () => {
    fake.states.set("bot-a", "ready");
    power.used("bot-a");
    busy.add("bot-a");
    await vi.advanceTimersByTimeAsync(3 * 60 * MINUTE);
    expect(sleeps()).toEqual([]);
    busy.delete("bot-a");
    // A full window from the first look (one a minute while busy) that finds it quiet.
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(sleeps()).toEqual([]);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(sleeps()).toEqual(["bot-a"]);
  });

  it("a person watching the live screen keeps it on; it sleeps ten minutes after they stop", async () => {
    fake.states.set("bot-a", "ready");
    power.used("bot-a");
    for (let frame = 0; frame < 60; frame += 1) {
      await vi.advanceTimersByTimeAsync(30_000);
      power.used("bot-a");
    }
    expect(sleeps()).toEqual([]);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(sleeps()).toEqual(["bot-a"]);
  });

  it("re-checks busy after the provider read and before the stop: work that arrived meanwhile keeps it on", async () => {
    fake.states.set("bot-a", "ready");
    let answer!: (machine: unknown) => void;
    fake.findBoat = vi.fn(() => new Promise(resolve => { answer = resolve; }));
    power.used("bot-a");
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(fake.findBoat).toHaveBeenCalledOnce();
    busy.add("bot-a");
    answer({ id: boxIdOf("bot-a"), state: "ready" });
    await vi.advanceTimersByTimeAsync(0);
    expect(sleeps()).toEqual([]);
    expect(claims).toEqual([]);

    busy.delete("bot-a");
    fake.findBoat = vi.fn(async () => ({ id: boxIdOf("bot-a"), state: "ready" }));
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(sleeps()).toEqual(["bot-a"]);
  });

  it("does not stop when its lifecycle lane is taken, and tries again a full window later", async () => {
    fake.states.set("bot-a", "ready");
    refuseClaim = true;
    power.used("bot-a");
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(sleeps()).toEqual([]);
    refuseClaim = false;
    await vi.advanceTimersByTimeAsync(10 * MINUTE - 1);
    expect(sleeps()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sleeps()).toEqual(["bot-a"]);
  });

  it("holds the lane for the whole stop, so no turn can start on a computer going to sleep", async () => {
    fake.states.set("bot-a", "ready");
    let stopped!: () => void;
    fake.sleepBoat = vi.fn(() => new Promise<void>(resolve => { stopped = resolve; }));
    power.used("bot-a");
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(claims).toEqual(["claim bot-a"]);
    stopped();
    await vi.advanceTimersByTimeAsync(0);
    expect(claims).toEqual(["claim bot-a", "release bot-a"]);
  });

  it("backs off a stop that fails and logs it, never retrying in a tight loop", async () => {
    fake.states.set("bot-a", "ready");
    fake.sleepBoat = vi.fn(async () => { throw new Error("boat sleep failed (503)"); });
    power.used("bot-a");
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(fake.sleepBoat).toHaveBeenCalledTimes(1);
    expect(logs).toEqual(["cloud computer bot-a: could not go to sleep, retrying in 10 min: boat sleep failed (503)"]);
    expect(claims).toEqual(["claim bot-a", "release bot-a"]);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(fake.sleepBoat).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(19 * MINUTE);
    expect(fake.sleepBoat).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(fake.sleepBoat).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(5 * 60 * MINUTE);
    expect(fake.sleepBoat.mock.calls.length).toBeLessThanOrEqual(9);
  });

  it("a failed provider read backs off the same way", async () => {
    fake.findBoat = vi.fn(async () => { throw Object.assign(new Error("Could not reach boat.dev"), { status: 503 }); });
    power.used("bot-a");
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(fake.findBoat).toHaveBeenCalledTimes(2);
    expect(logs[0]).toMatch(/could not go to sleep, retrying in 10 min: Could not reach boat\.dev/);
  });

  it("never stops a computer being deleted, and stops timing it", async () => {
    fake.states.set("bot-a", "ready");
    fake.deleting.add("bot-a");
    power.used("bot-a");
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(fake.findBoat).not.toHaveBeenCalled();
    expect(sleeps()).toEqual([]);
  });

  it("never stops a computer whose creation is unfinished; it waits until it is", async () => {
    fake.states.set("bot-a", "ready");
    fake.creating.add("bot-a");
    power.used("bot-a");
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(fake.findBoat).not.toHaveBeenCalled();
    fake.creating.delete("bot-a");
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(sleeps()).toEqual(["bot-a"]);
  });

  it("leaves a computer that is starting until it is ready, and one already asleep or gone alone", async () => {
    fake.states.set("starting", "provisioning");
    fake.states.set("asleep", "archived");
    for (const owner of ["starting", "asleep", "gone"]) power.used(owner);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(sleeps()).toEqual([]);
    fake.states.set("starting", "ready");
    fake.states.set("asleep", "ready");
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(sleeps()).toEqual(["starting"]);
  });

  it("the next use wakes a sleeping computer and times it again", async () => {
    fake.states.set("bot-a", "archived");
    const machine = await power.start(bot("bot-a"), turn("t1"));
    expect(machine).toMatchObject({ id: boxIdOf("bot-a"), state: "ready" });
    expect(fake.readyBoat).toHaveBeenCalledOnce();
    expect(broadcasts).toEqual([{ kind: "computer", botId: "bot-a", state: "waking", place: "cloud" }]);
    power.released(turn("t1"));
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(sleeps()).toEqual(["bot-a"]);

    const again = await power.start(bot("bot-a"), turn("t2"));
    expect(again).toMatchObject({ state: "ready" });
    expect(fake.readyBoat).toHaveBeenCalledTimes(2);
  });

  it("the first use creates the computer, and a start that fails still leaves it timed", async () => {
    expect(await power.start(bot("new"), turn("t1"))).toMatchObject({ state: "ready" });
    expect(fake.provisionBoat).toHaveBeenCalledOnce();
    expect(broadcasts).toEqual([{ kind: "computer", botId: "new", state: "provisioning", place: "cloud" }]);

    fake.states.set("slow", "archived");
    fake.readyBoat = vi.fn(async () => { fake.states.set("slow", "ready"); throw new Error("the cloud computer did not wake in time"); });
    await expect(power.start(bot("slow"), turn("t2"))).rejects.toThrow("did not wake");
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(sleeps().sort()).toEqual(["new", "slow"]);
  });

  it("a start that outlives its turn keeps the computer on until the start is done", async () => {
    let created!: () => void;
    fake.provisionBoat = vi.fn(() => new Promise<void>(resolve => { created = () => { fake.states.set("new", "ready"); resolve(); }; }));
    const started = power.start(bot("new"), turn("t1"));
    await vi.advanceTimersByTimeAsync(0);
    fake.states.set("new", "ready");
    power.released(turn("t1"));
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(sleeps()).toEqual([]);
    created();
    await started;
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(sleeps()).toEqual([]);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(sleeps()).toEqual(["new"]);
  });

  it("after a restart, arms every computer this installation still has on, and only those", async () => {
    for (const [owner, state] of [["on", "ready"], ["idle", "idle"], ["off", "archived"], ["going", "removing"], ["booting", "provisioning"]]) {
      fake.states.set(owner, state);
    }
    fake.listManagedBoats = vi.fn(async (): Promise<ManagedBoatInventory> => ({
      configured: true, available: true, problem: null,
      instances: [
        ...[...fake.states].map(([owner, state]) => ({ boxId: boxIdOf(owner), name: owner, state, ownerBotId: owner, ownerName: owner, orphaned: false, inUse: false })),
        { boxId: "bx_orphan", name: "orphan", state: "ready", ownerBotId: null, ownerName: null, orphaned: true, inUse: false },
      ],
    }));
    await power.armRunning();
    expect(fake.listManagedBoats).toHaveBeenCalledWith(expect.anything(), [], { adoptLegacy: false });
    await vi.advanceTimersByTimeAsync(10 * MINUTE - 1);
    expect(sleeps()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sleeps().sort()).toEqual(["idle", "on"]);
    expect(fake.findBoat.mock.calls.map(([, owner]) => owner).sort()).toEqual(["booting", "idle", "on"]);
  });

  it("after a restart, a computer still in use is armed but kept on while it is", async () => {
    fake.states.set("busy", "ready");
    busy.add("busy");
    fake.listManagedBoats = vi.fn(async (): Promise<ManagedBoatInventory> => ({
      configured: true, available: true, problem: null,
      instances: [{ boxId: boxIdOf("busy"), name: "busy", state: "ready", ownerBotId: "busy", ownerName: "busy", orphaned: false, inUse: true }],
    }));
    await power.armRunning();
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(sleeps()).toEqual([]);
    busy.delete("busy");
    await vi.advanceTimersByTimeAsync(11 * MINUTE);
    expect(sleeps()).toEqual(["busy"]);
  });

  it("a listing that fails at startup is retried later, with backoff, until it works", async () => {
    fake.states.set("on", "ready");
    fake.listManagedBoats = vi.fn()
      .mockResolvedValueOnce({ configured: true, available: false, problem: "boat.dev could not list cloud computers (502)", instances: [] })
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValue({
        configured: true, available: true, problem: null,
        instances: [{ boxId: boxIdOf("on"), name: "on", state: "ready", ownerBotId: "on", ownerName: "on", orphaned: false, inUse: false }],
      });
    await power.armRunning();
    expect(logs).toEqual(["cloud computers: could not list them to time the ones left on, retrying in 10 min: boat.dev could not list cloud computers (502)"]);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(fake.listManagedBoats).toHaveBeenCalledTimes(2);
    expect(logs[1]).toMatch(/retrying in 20 min: listing failed$/);
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    expect(fake.listManagedBoats).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(sleeps()).toEqual(["on"]);
  });

  it("does nothing without a Boat account, and nothing after close", async () => {
    fake.configured = false;
    fake.states.set("bot-a", "ready");
    power.used("bot-a");
    await power.armRunning();
    expect(fake.listManagedBoats).not.toHaveBeenCalled();

    fake.configured = true;
    power.used("bot-a");
    power.close();
    power.used("bot-a");
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(fake.findBoat).not.toHaveBeenCalled();
  });

  it("renewing a computer that is not timed starts nothing", async () => {
    fake.states.set("bot-a", "ready");
    power.renew("bot-a");
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(fake.findBoat).not.toHaveBeenCalled();

    power.used("bot-a");
    await vi.advanceTimersByTimeAsync(9 * MINUTE);
    power.renew("bot-a");
    await vi.advanceTimersByTimeAsync(9 * MINUTE);
    expect(sleeps()).toEqual([]);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(sleeps()).toEqual(["bot-a"]);
  });

  describe("a routine due soon", () => {
    const due = (botId: string, inMs: number, computer = botId) => {
      computers.set(botId, computer);
      const routine = { botId, runOn: "maus" as const, enabled: true, nextRunAt: Date.now() + inMs };
      routines.push(routine);
      return routine;
    };
    /** The scheduler moves the routine on to its next run, and this run's turn holds the computer for two minutes. */
    const run = async (routine: (typeof routines)[number], nextInMs: number, threadId: string) => {
      routine.nextRunAt = Date.now() + nextInMs;
      await power.start(bot(routine.botId), turn(threadId));
      busy.add(routine.botId);
      await vi.advanceTimersByTimeAsync(2 * MINUTE);
      busy.delete(routine.botId);
      power.released(turn(threadId));
    };

    it("means within 30 minutes, longer than the idle window", () => {
      expect(ROUTINE_DUE_SOON_MS).toBe(30 * MINUTE);
      expect(ROUTINE_DUE_SOON_MS).toBeGreaterThan(CLOUD_COMPUTER_IDLE_MS);
    });

    it("keeps its bot's computer on when it is due in 20 minutes; after that run, with the next a day off, it sleeps", async () => {
      fake.states.set("bot-a", "ready");
      const routine = due("bot-a", 20 * MINUTE);
      power.used("bot-a");
      await vi.advanceTimersByTimeAsync(20 * MINUTE);
      expect(sleeps()).toEqual([]);
      await run(routine, 24 * HOUR, "run");
      expect(fake.readyBoat).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10 * MINUTE - 1);
      expect(sleeps()).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(sleeps()).toEqual(["bot-a"]);
    });

    it.each([[15, 1], [30, 1], [60, 4]])("a routine every %i minutes wakes its computer %i time(s) in four runs", async (everyMinutes, wakes) => {
      fake.states.set("bot-a", "archived");
      const routine = due("bot-a", everyMinutes * MINUTE);
      for (let n = 0; n < 4; n++) {
        await vi.advanceTimersByTimeAsync(routine.nextRunAt - Date.now());
        await run(routine, everyMinutes * MINUTE, `run-${n}`);
      }
      expect(fake.readyBoat).toHaveBeenCalledTimes(wakes);
      expect(sleeps()).toHaveLength(wakes - 1);
    });

    it("a teammate's routine keeps the team's shared computer on, and no other computer", async () => {
      fake.states.set("computer_ops", "ready");
      fake.states.set("carl", "ready");
      const routine = due("ben", 15 * MINUTE, "computer_ops");
      power.attached(turn("ada"), "computer_ops");
      power.released(turn("ada"));
      power.used("carl");
      await vi.advanceTimersByTimeAsync(15 * MINUTE);
      expect(sleeps()).toEqual(["carl"]);

      routine.nextRunAt = Date.now() + 2 * HOUR;
      power.attached(turn("ben"), "computer_ops");
      busy.add("computer_ops");
      await vi.advanceTimersByTimeAsync(2 * MINUTE);
      busy.delete("computer_ops");
      power.released(turn("ben"));
      await vi.advanceTimersByTimeAsync(10 * MINUTE);
      expect(sleeps()).toEqual(["carl", "computer_ops"]);
    });

    it("due in two hours, it lets the computer sleep, and that run wakes it", async () => {
      fake.states.set("bot-a", "ready");
      const routine = due("bot-a", 2 * HOUR);
      power.used("bot-a");
      await vi.advanceTimersByTimeAsync(10 * MINUTE);
      expect(sleeps()).toEqual(["bot-a"]);

      await vi.advanceTimersByTimeAsync(routine.nextRunAt - Date.now());
      await run(routine, 2 * HOUR, "run");
      expect(fake.readyBoat).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(10 * MINUTE);
      expect(sleeps()).toEqual(["bot-a", "bot-a"]);
    });

    it("paused, with no next run it can work out, or for a bot that uses no cloud computer, it keeps nothing on", async () => {
      for (const owner of ["paused", "unscheduled", "elsewhere"]) fake.states.set(owner, "ready");
      due("paused", 20 * MINUTE).enabled = false;
      Object.assign(due("unscheduled", 20 * MINUTE), { nextRunAt: null });
      due("elsewhere", 20 * MINUTE);
      computers.delete("elsewhere");
      for (const owner of ["paused", "unscheduled", "elsewhere"]) power.used(owner);
      await vi.advanceTimersByTimeAsync(10 * MINUTE);
      expect(sleeps().sort()).toEqual(["elsewhere", "paused", "unscheduled"]);
    });
  });
});
