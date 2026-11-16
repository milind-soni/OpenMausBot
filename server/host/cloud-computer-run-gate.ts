// An unattended run (a routine, an automation, a webhook) has nobody watching a computer that is awake but silent. Before
// such a run starts, its cloud computer is woken and has to answer; while it does not, the recovery in boat-recovery.ts
// waits for a disk restore and restarts it once, and the run either starts or ends with the reason. A run whose computer
// ended well but whose last computer call got no answer is left as done, with a note: starting it again could repeat
// what it already did (a message sent, a pull request opened). Only a run nobody started by hand is held.
//
// Waking costs computer time, and many routines never touch the bot's cloud computer, so only a routine whose earlier
// run used the computer is woken for. Which routines those are is remembered across restarts where `remember` is given.
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
  awaitAnswer(boxId: string, opts: { woke: boolean; deadline: number; signal?: AbortSignal }): Promise<BoatAnswer>;
  /** Why the recovery left the owner's silent computer as it is, when it decided that at or after `since`. */
  verdict(owner: string, since: number): RecoveryVerdict | null;
  recoveryState(owner: string): CloudComputerRecoveryState | null;
  /** Reads the computer's disk and frees space on it when it is nearly full; resolves when the run may start or `signal`
   * aborts. A number: the disk is still that many percent full, and the run starts all the same. */
  disk?(boxId: string, signal?: AbortSignal): Promise<number | null | void>;
  /** Where the routines whose runs used the cloud computer are kept across restarts, so the first run after one is held too. */
  remember?: { load(): string[]; save(ids: string[]): void };
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
  /** Routines whose runs have used the cloud computer. */
  const usesComputer = new Set<string>(deps.remember?.load().slice(-MAX_ROUTINES) ?? []);
  /** Threads whose latest computer call got no answer, with the bot whose turn it was. */
  const silent = new Map<string, string>();
  /** Routines whose run started with the disk still almost full, then the threads of those runs once they use the computer. */
  const startedFull = new Set<string>();
  const fullThreads = new Set<string>();

  async function ready(owner: string, routineId: string, signal?: AbortSignal): Promise<string | null> {
    const began = now();
    let machine = await deps.find(owner).catch(() => null);
    if (!machine || signal?.aborted) return null;
    let woke = false;
    if (SLEEPING.has(machine.state)) {
      machine = await deps.wake(owner, WAKE_BUDGET_MS).catch(() => null);
      if (!machine) return RUN_COMPUTER_LINES.noWake;
      woke = true;
    }
    const deadline = now() + RUN_COMPUTER_WAIT_MS;
    for (;;) {
      if (signal?.aborted) return null;
      deps.used(owner);
      const answer = await deps.awaitAnswer(machine.id, { woke, deadline, ...(signal ? { signal } : {}) });
      if (answer.ok && !signal?.aborted && typeof await deps.disk?.(machine.id, signal).catch(() => null) === "number") {
        if (startedFull.size >= MAX_ROUTINES) startedFull.clear();
        startedFull.add(routineId);
      }
      if (answer.ok || signal?.aborted) return null;
      // A verdict from before this wait belongs to an earlier silence, not this one.
      const why = deps.verdict(owner, began);
      if (why) return VERDICT_LINE[why];
      const state = deps.recoveryState(owner);
      if ((state && ENDED.has(state)) || now() >= deadline - 5_000) {
        // The recovery writes its verdict before it ends; read once more in case it ended between the two reads above.
        const late = deps.verdict(owner, began);
        return late ? VERDICT_LINE[late] : RUN_COMPUTER_LINES.noAnswer;
      }
      woke = true;
    }
  }

  return {
    /** null: nothing to wait for. Otherwise resolves null once the computer answers, or with why the run cannot start. */
    prepare(run: RunLike, signal?: AbortSignal): Promise<string | null> | null {
      if (run.target !== "bot" || !usesComputer.has(run.routineId)) return null;
      const owner = deps.computerOf(run);
      if (!owner) return null;
      startedFull.delete(run.routineId);
      return ready(owner, run.routineId, signal).then((reason) => {
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
      if (!answered) { silent.set(threadId, botId); return; }
      silent.delete(threadId);
      const routineId = deps.routineOf(botId, threadId);
      if (routineId && startedFull.delete(routineId)) {
        if (fullThreads.size >= MAX_ROUTINES) fullThreads.clear();
        fullThreads.add(threadId);
      }
      if (!routineId || usesComputer.has(routineId)) return;
      if (usesComputer.size >= MAX_ROUTINES) usesComputer.delete(usesComputer.values().next().value!);
      usesComputer.add(routineId);
      deps.remember?.save([...usesComputer]);
    },
    /** When a turn ends: the note for an unattended run that ended well although its last computer call got no answer,
     * and for one that used a computer whose disk was still almost full when it started, however it ended.
     * The run stays done. A turn that failed is the scheduler's to start once more, as any failed run is. */
    turnEnded(threadId: string, ok: boolean): string | null {
      const botId = silent.get(threadId);
      silent.delete(threadId);
      const unanswered = ok && botId !== undefined && deps.routineOf(botId, threadId) ? RUN_COMPUTER_LINES.lastCallUnanswered : null;
      const full = fullThreads.delete(threadId) ? RUN_COMPUTER_LINES.diskStillFull : null;
      return full && unanswered ? `${full} ${unanswered}` : full ?? unanswered;
    },
  };
}

export type RunComputerGate = ReturnType<typeof createRunComputerGate>;
