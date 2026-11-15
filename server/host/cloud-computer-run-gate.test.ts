import { describe, expect, it } from "vitest";

import { RUN_COMPUTER_LINES, type CloudComputerRecoveryState } from "../../shared/cloud-computer-recovery.ts";
import type { BoatAnswer } from "../boat-ready.ts";
import type { RecoveryVerdict } from "../boat-recovery.ts";
import { createRunComputerGate, RUN_COMPUTER_WAIT_MS } from "./cloud-computer-run-gate.ts";

const RUN = { routineId: "routine-1", botId: "bot-1", target: "bot", runOn: "cloud" };

function harness(over: { state?: string; answers?: (wait: number) => boolean; wakes?: boolean } = {}) {
  let at = 0;
  const seen = { finds: 0, wakes: 0, waits: [] as boolean[], used: 0 };
  const world = { verdict: null as RecoveryVerdict | null, recovery: null as CloudComputerRecoveryState | null, machine: { id: "bx_23456789", state: over.state ?? "idle" } as { id: string; state: string } | null };
  const gate = createRunComputerGate({
    computerOf: () => "bot-1",
    find: async () => { seen.finds++; return world.machine; },
    wake: async () => { seen.wakes++; return over.wakes === false ? null : { id: "bx_23456789", state: "idle" }; },
    awaitAnswer: async (_boxId, opts): Promise<BoatAnswer> => {
      seen.waits.push(opts.woke);
      if (over.answers?.(seen.waits.length) ?? true) return { ok: true, waitedMs: 0 };
      at += 90_000;
      return { ok: false, phase: "waking", waitedMs: 90_000 };
    },
    verdict: () => world.verdict, recoveryState: () => world.recovery,
    used: () => { seen.used++; }, routineOf: () => "routine-1", log: () => {}, now: () => at,
  });
  return { gate, seen, world, used: () => gate.callSettled("bot-1", "thread-1", true), now: () => at };
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
    await expect(h.gate.prepare(RUN)).resolves.toBe(line);
  });

  it("gives up after twenty minutes whatever the recovery is doing", async () => {
    const h = harness({ answers: () => false });
    h.used();
    await expect(h.gate.prepare(RUN)).resolves.toBe(RUN_COMPUTER_LINES.noAnswer);
    expect(h.now()).toBeGreaterThanOrEqual(RUN_COMPUTER_WAIT_MS - 5_000);
    expect(h.now()).toBeLessThanOrEqual(RUN_COMPUTER_WAIT_MS + 90_000);
  });

  it("starts a run once more when its turn ended well but its last computer call got no answer", () => {
    const h = harness();
    h.gate.callSettled("bot-1", "thread-1", false);
    expect(h.gate.turnEnded("thread-1", true)).toBe(RUN_COMPUTER_LINES.duringRun);
    expect(h.gate.turnEnded("thread-1", true)).toBeNull();
    h.gate.callSettled("bot-1", "thread-1", false);
    h.gate.callSettled("bot-1", "thread-1", true);
    expect(h.gate.turnEnded("thread-1", true)).toBeNull();
    h.gate.callSettled("bot-1", "thread-1", false);
    expect(h.gate.turnEnded("thread-1", false)).toBeNull();
  });
});
