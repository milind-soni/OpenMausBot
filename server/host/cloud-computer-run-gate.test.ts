import { describe, expect, it } from "vitest";

import { RUN_COMPUTER_LINES, type CloudComputerRecoveryState } from "../../shared/cloud-computer-recovery.ts";
import type { BoatAnswer } from "../boat-ready.ts";
import type { RecoveryVerdict } from "../boat-recovery.ts";
import { createRunComputerGate, RUN_COMPUTER_WAIT_MS } from "./cloud-computer-run-gate.ts";

const RUN = { routineId: "routine-1", botId: "bot-1", target: "bot", runOn: "cloud" };

function harness(over: { state?: string; answers?: (wait: number) => boolean; wakes?: boolean; disk?: (boxId: string, signal?: AbortSignal) => Promise<number | null | void>; remember?: { load(): string[]; save(ids: string[]): void } } = {}) {
  let at = 0;
  const seen = { finds: 0, wakes: 0, waits: [] as boolean[], signals: [] as Array<AbortSignal | undefined>, used: 0 };
  const world = { verdict: null as RecoveryVerdict | null, verdictAt: 0, routine: "routine-1" as string | null, recovery: null as CloudComputerRecoveryState | null, machine: { id: "bx_23456789", state: over.state ?? "idle" } as { id: string; state: string } | null };
  const gate = createRunComputerGate({
    computerOf: () => "bot-1",
    find: async () => { seen.finds++; return world.machine; },
    wake: async () => { seen.wakes++; return over.wakes === false ? null : { id: "bx_23456789", state: "idle" }; },
    awaitAnswer: async (_boxId, opts): Promise<BoatAnswer> => {
      seen.waits.push(opts.woke);
      seen.signals.push(opts.signal);
      if (over.answers?.(seen.waits.length) ?? true) return { ok: true, waitedMs: 0 };
      at += 90_000;
      return { ok: false, phase: "waking", waitedMs: 90_000 };
    },
    verdict: (_owner, since) => (world.verdict && world.verdictAt >= since ? world.verdict : null), recoveryState: () => world.recovery,
    used: () => { seen.used++; }, routineOf: () => world.routine, log: () => {}, now: () => at, ...(over.disk ? { disk: over.disk } : {}), ...(over.remember ? { remember: over.remember } : {}),
  });
  return { gate, seen, world, used: () => gate.callSettled("bot-1", "thread-1", true), now: () => at, advance: (ms: number) => { at += ms; } };
}

describe("an unattended run and its cloud computer", () => {
  it("wakes nothing for a routine that has not used the computer, or a run that is not a bot's", async () => {
    const h = harness();
    expect(h.gate.prepare(RUN)).toBeNull();
    h.used();
    expect(h.gate.prepare({ ...RUN, target: "room-goal" })).toBeNull();
    expect(h.seen.finds).toBe(0);
  });

  it("starts at once when the computer is awake and answers", async () => {
    const h = harness();
    h.used();
    await expect(h.gate.prepare(RUN)).resolves.toBeNull();
    expect(h.seen).toMatchObject({ wakes: 0, waits: [false], used: 1 });
  });

  it("makes room on the computer's disk once it answers, before the run starts", async () => {
    const order: string[] = [];
    let cleaned!: () => void;
    const h = harness({ disk: (boxId) => { order.push(`disk ${boxId}`); return new Promise<void>((resolve) => { cleaned = resolve; }); } });
    h.used();
    const starting = h.gate.prepare(RUN)!.then((reason) => { order.push(`start ${reason}`); });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order).toEqual(["disk bx_23456789"]);
    cleaned();
    await starting;
    expect(order).toEqual(["disk bx_23456789", "start null"]);
  });

  it("holds a routine's first run after a restart too, and checks its disk, when an earlier server saw it use the computer", async () => {
    const saved: string[][] = [];
    let checked = 0;
    const before = harness({ remember: { load: () => [], save: (ids) => { saved.push(ids); } } });
    expect(before.gate.prepare(RUN)).toBeNull();
    before.used();
    before.used();
    expect(saved).toEqual([["routine-1"]]);

    const restarted = harness({ remember: { load: () => saved.at(-1)!, save: () => {} }, disk: async () => { checked++; } });
    await expect(restarted.gate.prepare(RUN)).resolves.toBeNull();
    expect(restarted.seen.waits).toEqual([false]);
    expect(checked).toBe(1);
    expect(restarted.gate.prepare({ ...RUN, routineId: "routine-never-used-it" })).toBeNull();
  });

  it("remembers a bounded number of routines, dropping the one that used the computer longest ago", async () => {
    let saved: string[] = [];
    const h = harness({ remember: { load: () => Array.from({ length: 500 }, (_unused, index) => `old-${index}`), save: (ids) => { saved = ids; } } });
    h.used();
    expect(saved).toHaveLength(500);
    expect(saved[0]).toBe("old-1");
    expect(saved.at(-1)).toBe("routine-1");
  });

  it("hands the disk step the run's own stop signal", async () => {
    const stop = new AbortController();
    let given: AbortSignal | undefined;
    const h = harness({ disk: async (_boxId, signal) => { given = signal; } });
    h.used();
    await h.gate.prepare(RUN, stop.signal);
    expect(given).toBe(stop.signal);
  });

  it("starts a run whose disk is still almost full, never skips it, and leaves a note on it once it has used the computer", async () => {
    const h = harness({ disk: async () => 97 });
    h.used();
    await expect(h.gate.prepare(RUN)).resolves.toBeNull();
    expect(h.gate.turnEnded("thread-other", true)).toBeNull();
    h.gate.callSettled("bot-1", "thread-1", true);
    expect(h.gate.turnEnded("thread-1", false)).toBe(RUN_COMPUTER_LINES.diskStillFull);
    expect(h.gate.turnEnded("thread-1", true)).toBeNull();

    await h.gate.prepare(RUN);
    h.gate.callSettled("bot-1", "thread-2", false);
    h.gate.callSettled("bot-1", "thread-2", true);
    h.gate.callSettled("bot-1", "thread-2", false);
    expect(h.gate.turnEnded("thread-2", true)).toBe(`${RUN_COMPUTER_LINES.diskStillFull} ${RUN_COMPUTER_LINES.lastCallUnanswered}`);
  });

  it("leaves no disk note on a run that started with room, or on the run after one that did not", async () => {
    let full: number | null = 97;
    const h = harness({ disk: async () => full });
    h.used();
    await h.gate.prepare(RUN);
    full = null;
    await h.gate.prepare(RUN);
    h.gate.callSettled("bot-1", "thread-1", true);
    expect(h.gate.turnEnded("thread-1", true)).toBeNull();
  });

  it("starts the run all the same when the disk cleanup fails, and never cleans a computer that did not answer", async () => {
    const failing = harness({ disk: async () => { throw new Error("df failed"); } });
    failing.used();
    await expect(failing.gate.prepare(RUN)).resolves.toBeNull();

    let asked = 0;
    const silent = harness({ answers: () => false, disk: async () => { asked++; } });
    silent.used();
    await expect(silent.gate.prepare(RUN)).resolves.toBe(RUN_COMPUTER_LINES.noAnswer);
    expect(asked).toBe(0);
  });

  it("wakes a sleeping computer and waits for its answer, however recently it answered", async () => {
    const h = harness({ state: "archived" });
    h.used();
    await expect(h.gate.prepare(RUN)).resolves.toBeNull();
    expect(h.seen).toMatchObject({ wakes: 1, waits: [true] });
  });

  it("leaves a bot with no computer yet to its turn", async () => {
    const h = harness();
    h.used();
    h.world.machine = null;
    await expect(h.gate.prepare(RUN)).resolves.toBeNull();
    expect(h.seen.waits).toEqual([]);
  });

  it("says so when the computer does not wake", async () => {
    const h = harness({ state: "archived", wakes: false });
    h.used();
    await expect(h.gate.prepare(RUN)).resolves.toBe(RUN_COMPUTER_LINES.noWake);
  });

  it("keeps waiting while the recovery works on a silent computer, and starts once it answers", async () => {
    const h = harness({ answers: (wait) => wait >= 4 });
    h.used();
    await expect(h.gate.prepare(RUN)).resolves.toBeNull();
    expect(h.seen.waits).toEqual([false, true, true, true]);
    expect(h.seen.used).toBe(4);
  });

  it.each<[RecoveryVerdict, string]>([
    ["restart-failed", RUN_COMPUTER_LINES.afterRestart], ["person-busy", RUN_COMPUTER_LINES.personBusy],
    ["restart-limited", RUN_COMPUTER_LINES.restartLimited], ["shared", RUN_COMPUTER_LINES.shared],
  ])("ends with the reason once the recovery left the computer as it is (%s)", async (verdict, line) => {
    const h = harness({ answers: () => false });
    h.used();
    h.world.verdict = verdict;
    h.world.verdictAt = 1;
    await expect(h.gate.prepare(RUN)).resolves.toBe(line);
  });

  it("does not take a verdict from an earlier silence for this wait's", async () => {
    const h = harness({ answers: (wait) => wait >= 2 });
    h.used();
    h.world.verdict = "restart-failed";
    h.world.verdictAt = 500;
    h.advance(60_000);
    await expect(h.gate.prepare(RUN)).resolves.toBeNull();
    expect(h.seen.waits).toHaveLength(2);
  });

  it("reads the verdict once more when the recovery has ended, so a reason written a moment later is not missed", async () => {
    let reads = 0;
    const gate = createRunComputerGate({
      computerOf: () => "bot-1", find: async () => ({ id: "bx_23456789", state: "idle" }), wake: async () => null,
      awaitAnswer: async () => ({ ok: false, phase: "waking", waitedMs: 90_000 }),
      // Nothing at the first read; written by the time the state reads as ended.
      verdict: () => (++reads >= 2 ? "restart-failed" : null), recoveryState: () => "needs-person",
      used: () => {}, routineOf: () => "routine-1", log: () => {}, now: () => 0,
    });
    gate.callSettled("bot-1", "thread-1", true);
    await expect(gate.prepare(RUN)).resolves.toBe(RUN_COMPUTER_LINES.afterRestart);
  });

  it("stops waiting, and wakes nothing more, once the run it waits for is gone", async () => {
    const stop = new AbortController();
    const h = harness({ answers: () => { stop.abort(); return false; } });
    h.used();
    await expect(h.gate.prepare(RUN, stop.signal)).resolves.toBeNull();
    expect(h.seen.waits).toHaveLength(1);
    expect(h.seen.signals[0]).toBe(stop.signal);
    const gone = new AbortController();
    gone.abort();
    const asleep = harness({ state: "archived" });
    asleep.used();
    await asleep.gate.prepare(RUN, gone.signal);
    expect(asleep.seen.wakes).toBe(0);
  });

  it("gives up after twenty minutes whatever the recovery is doing", async () => {
    const h = harness({ answers: () => false });
    h.used();
    await expect(h.gate.prepare(RUN)).resolves.toBe(RUN_COMPUTER_LINES.noAnswer);
    expect(h.now()).toBeGreaterThanOrEqual(RUN_COMPUTER_WAIT_MS - 5_000);
    expect(h.now()).toBeLessThanOrEqual(RUN_COMPUTER_WAIT_MS + 90_000);
  });

  it("leaves a run that ended well as done, with a note, when its last computer call got no answer: it is not run again", () => {
    const h = harness();
    h.gate.callSettled("bot-1", "thread-1", false);
    expect(h.gate.turnEnded("thread-1", true)).toBe(RUN_COMPUTER_LINES.lastCallUnanswered);
    expect(h.gate.turnEnded("thread-1", true)).toBeNull();
    h.gate.callSettled("bot-1", "thread-1", false);
    h.gate.callSettled("bot-1", "thread-1", true);
    expect(h.gate.turnEnded("thread-1", true)).toBeNull();
  });

  it("says nothing for a turn that failed, which the scheduler starts once more as it does any failed run, or for a person's own turn", () => {
    const h = harness();
    h.gate.callSettled("bot-1", "thread-1", false);
    expect(h.gate.turnEnded("thread-1", false)).toBeNull();
    h.world.routine = null;
    h.gate.callSettled("bot-1", "thread-2", false);
    expect(h.gate.turnEnded("thread-2", true)).toBeNull();
  });
});
