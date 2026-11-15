// An unattended run (a routine, an automation, a webhook) has nobody watching a computer that is awake but silent. Before
// such a run starts, its cloud computer is woken and has to answer; while it does not, the recovery in boat-recovery.ts
// waits for a disk restore and restarts it once, and the run either starts or ends with the reason. A run whose computer
// went silent part-way is started once more instead of being reported as done.
//
// Waking costs computer time, and many routines never touch the bot's cloud computer, so only a routine whose earlier
// run used the computer is woken for; the first run after a server start is not, and waits at its first computer call.
import { RUN_COMPUTER_LINES, type CloudComputerRecoveryState } from "../../shared/cloud-computer-recovery.ts";
import type { BoatAnswer } from "../boat-ready.ts";
import type { RecoveryVerdict } from "../boat-recovery.ts";

/** The longest a run waits for its computer before it starts: one minute to notice the silence, up to ten for a disk
 * restore the provider reports, then one restart (stop, wake, and the wait for an answer) with room to spare. */
export const RUN_COMPUTER_WAIT_MS = 20 * 60_000;
const WAKE_BUDGET_MS = 150_000;
const MAX_ROUTINES = 500;
const ENDED = new Set<CloudComputerRecoveryState>(["needs-person", "unreachable", "capped"]);
const SLEEPING = new Set(["archived", "archiving"]);

interface RunLike { routineId: string; botId: string; target: string; runOn?: string }
interface Machine { id: string; state: string }

export interface RunComputerGateDeps {
  /** The owner key of the cloud computer this run's turns use, or null when they use none. */
  computerOf(run: RunLike): string | null;
  find(owner: string): Promise<Machine | null>;
  /** Wakes the owner's sleeping computer, never creates one; null when it did not wake in time. */
  wake(owner: string, budgetMs: number): Promise<Machine | null>;
  awaitAnswer(boxId: string, opts: { woke: boolean; deadline: number }): Promise<BoatAnswer>;
  verdict(owner: string): RecoveryVerdict | null;
  recoveryState(owner: string): CloudComputerRecoveryState | null;
  /** Restarts the owner's idle window, so the wait itself does not put the computer to sleep. */
  used(owner: string): void;
  /** The routine whose run is active in this bot's thread, if one is. */
  routineOf(botId: string, threadId: string): string | null;
  log(line: string): void;
  now?(): number;
}

const VERDICT_LINE: Record<RecoveryVerdict, string> = {
  "restart-failed": RUN_COMPUTER_LINES.afterRestart, "person-busy": RUN_COMPUTER_LINES.personBusy,
  "restart-limited": RUN_COMPUTER_LINES.restartLimited, shared: RUN_COMPUTER_LINES.shared,
};

export function createRunComputerGate(deps: RunComputerGateDeps) {
  const now = deps.now ?? Date.now;
  /** Routines whose runs have used the cloud computer since the server started. */
  const usesComputer = new Set<string>();
  /** Threads whose latest computer call got no answer. */
  const silent = new Set<string>();

  async function ready(owner: string): Promise<string | null> {
    let machine = await deps.find(owner).catch(() => null);
    if (!machine) return null;
    let woke = false;
    if (SLEEPING.has(machine.state)) {
      machine = await deps.wake(owner, WAKE_BUDGET_MS).catch(() => null);
      if (!machine) return RUN_COMPUTER_LINES.noWake;
      woke = true;
    }
    const deadline = now() + RUN_COMPUTER_WAIT_MS;
    for (;;) {
      deps.used(owner);
      const answer = await deps.awaitAnswer(machine.id, { woke, deadline });
      if (answer.ok) return null;
      const why = deps.verdict(owner);
      if (why) return VERDICT_LINE[why];
      const state = deps.recoveryState(owner);
      if (state && ENDED.has(state)) return RUN_COMPUTER_LINES.noAnswer;
      if (now() >= deadline - 5_000) return RUN_COMPUTER_LINES.noAnswer;
      woke = true;
    }
  }

  return {
    /** null: nothing to wait for. Otherwise resolves null once the computer answers, or with why the run cannot start. */
    prepare(run: RunLike): Promise<string | null> | null {
      if (run.target !== "bot" || !usesComputer.has(run.routineId)) return null;
      const owner = deps.computerOf(run);
      if (!owner) return null;
      return ready(owner).then((reason) => {
        if (reason) deps.log(`routine ${run.routineId}: its cloud computer (${owner}) was not ready: ${reason}`);
        return reason;
      }, (error) => {
        // A lookup that fails is the turn's to report in its own words.
        deps.log(`routine ${run.routineId}: could not check its cloud computer: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
    },
    /** After each computer call of a turn: whether the computer answered it. */
    callSettled(botId: string, threadId: string, answered: boolean): void {
      if (!answered) { silent.add(threadId); return; }
      silent.delete(threadId);
      const routineId = deps.routineOf(botId, threadId);
      if (!routineId || usesComputer.has(routineId)) return;
      if (usesComputer.size >= MAX_ROUTINES) usesComputer.clear();
      usesComputer.add(routineId);
    },
    /** When a turn ends: why its run is not done, when the turn ended well but its last computer call got no answer. */
    turnEnded(threadId: string, ok: boolean): string | null {
      return silent.delete(threadId) && ok ? RUN_COMPUTER_LINES.duringRun : null;
    },
  };
}

export type RunComputerGate = ReturnType<typeof createRunComputerGate>;
