// The tick that turns board storage (task-board.ts) into a working
// queue. It owns no state of its own beyond the interval timer and the
// re-entrancy guard below — every decision reads and writes through the
// board's state machine, so a restart loses nothing but the timer.
//
// Order inside one tick is the whole design: reclaim -> give up ->
// promote -> claim.
//   - Reclaiming first means a task whose bot died is back in the pool
//     within the same tick, before the concurrency cap is measured.
//   - Giving up before promoting means a cursed task (one that keeps
//     killing its bot) cannot consume a claim slot every tick forever —
//     it is blocked before promotion and claim even look at it.
//   - Promoting before claiming means a todo task that just became
//     eligible this tick (its last parent finished) can be claimed in
//     the same pass, rather than waiting a full TICK_MS.
import {
  type BoardTask,
  attachThread,
  claimTask,
  listTasks,
  promotable,
  releaseClaim,
  setStatus,
  staleRunning,
} from "./task-board.ts";

export const TICK_MS = 30_000;
export const DEFAULT_STALE_AFTER_MS = 180_000;
export const DEFAULT_MAX_ATTEMPTS = 3;

export interface DispatcherOptions {
  /** Injectable clock so tests never sleep for real. */
  now?: () => number;
  /** Is the board turned on right now? Read live at the top of every tick,
   * so the flag stays hot-flippable — and so a tick with the flag off is a
   * genuine no-op rather than one that still reclaims, gives up, promotes
   * and claims. Turning a feature flag off must never mutate the data
   * behind it. Defaults to "on" for callers that own the gate themselves
   * (the tests). */
  enabled?: () => boolean;
  /** Can this task be dispatched AT ALL right now — synchronously, before
   * anything is claimed? Every "no" the wiring can give cheaply (no
   * assignee, the assignee is missing/busy/hidden, its approval mode is not
   * auto) belongs here rather than in dispatch(), because a claim is an
   * ATTEMPT and the give-up pass blocks a task that runs out of them. A task
   * nobody could ever have started must not walk itself to "blocked". */
  canDispatch?: (task: BoardTask) => boolean;
  /** Hand a claimed task to the turn machinery. Resolves when the turn
   * has been STARTED, not when it finishes — the board tracks the rest
   * through heartbeats and the completion callback. Returning null (or
   * throwing) means no turn started after all — the world changed between
   * canDispatch and the claim — so the task goes back to ready with its
   * attempt refunded, because an attempt counts only when a turn began. */
  dispatch: (task: BoardTask) => Promise<{ threadId: string } | null>;
  /** Concurrency cap across the whole board. P1 replaces this with a
   * budget-derived number; until then it is config with a default of 2. */
  maxRunning?: number;
  /** A running task whose last heartbeat is older than this is assumed
   * dead and returned to ready. */
  staleAfterMs?: number;
  /** Give up on a task that has been claimed this many times. */
  maxAttempts?: number;
  emit?: (payload: { kind: string; task: BoardTask }) => void;
}

export interface Dispatcher {
  tick(): Promise<void>;
  start(): void;
  stop(): void;
}

export function createDispatcher(options: DispatcherOptions): Dispatcher {
  const now = options.now ?? Date.now;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxRunning = options.maxRunning ?? 2;
  const canDispatch = options.canDispatch;
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;

  async function tick(): Promise<void> {
    // The flag gate is the FIRST thing in the tick, before any read or
    // write: with features.board off the board's data must be exactly as
    // the person left it — no reclaim, no give-up, no promote, no claim,
    // not even a bumped updated_at. It reads live config, so flipping the
    // flag back on takes effect on the very next tick with no restart.
    if (options.enabled && !options.enabled()) return;
    // A slow dispatch (an in-flight await options.dispatch(...)) must
    // never let a second tick double-claim the rest of the board.
    if (ticking) return;
    ticking = true;
    try {
      // reclaim: a running task whose heartbeat has gone cold is back in
      // the pool before anything below measures the concurrency cap.
      for (const dead of staleRunning(now() - staleAfterMs)) {
        const reclaimed = setStatus(dead.id, "ready");
        options.emit?.({ kind: "board.reclaimed", task: reclaimed });
      }

      // give up: a task keeps its attempt count from every claim,
      // including a reclaim (task-board.ts bumps it on every entry to
      // "running"). Once that count hits the cap the task is blocked
      // outright rather than being handed back into the pool to loop
      // again.
      //
      // This checks "ready" only, deliberately excluding "running":
      // attempts is a count of attempts STARTED, not attempts FAILED, so a
      // task on its final allowed attempt carries attempts === maxAttempts
      // while it is still legitimately in flight and might still succeed.
      // Scanning "running" here would force-block a healthy, heartbeating
      // task out from under itself for no reason but its own historical
      // attempt count — killing work that hasn't failed yet. The task
      // that actually needs to be judged is one back in "ready" asking
      // for ANOTHER attempt (reclaimed above, this tick or an earlier
      // one): that is the point where "no progress" is an established
      // fact, and where give-up must act before claim hands out a claim
      // it will never survive.
      for (const task of listTasks({ status: ["ready"] })) {
        if (task.attempts < maxAttempts) continue;
        const given = setStatus(task.id, "blocked", {
          blockedReason: `gave up after ${task.attempts} attempts — no progress`,
        });
        options.emit?.({ kind: "board.gave-up", task: given });
      }

      // promote: todo tasks with nothing left to wait for join the pool,
      // in the same tick that made them eligible.
      for (const task of promotable()) {
        const ready = setStatus(task.id, "ready");
        options.emit?.({ kind: "board.promoted", task: ready });
      }

      // claim: hand ready tasks to the turn machinery up to the cap.
      let slots = maxRunning - listTasks({ status: ["running"] }).length;
      for (const task of listTasks({ status: ["ready"] })) {
        if (slots <= 0) break;
        // Defense in depth: give-up above should already have blocked
        // anything at the cap, but a task promoted moments ago in this
        // same tick never had attempts near the cap anyway, so this is
        // just a belt-and-braces guard against claiming a cursed task.
        if (task.attempts >= maxAttempts) continue;
        // Ask BEFORE claiming. The claim is what charges an attempt, so a
        // task the wiring could never dispatch (unassigned, assignee busy or
        // hidden, not in auto-approve mode, board off) is skipped untouched
        // rather than claimed, declined, and charged — which is how an
        // unassigned task used to reach "gave up after 3 attempts" in two
        // minutes without a single turn ever starting.
        if (canDispatch && !canDispatch(task)) continue;
        // The claim is a conditional write: exactly one caller can move a
        // row out of "ready", even if a second process shares this database.
        const claimed = claimTask(task.id);
        if (!claimed) continue;
        let started: { threadId: string } | null;
        try {
          started = await options.dispatch(claimed);
        } catch {
          // A dispatch that threw started no turn either. Refund the claim
          // and keep ticking: one bad task must not take the whole pass
          // down. The wiring owns reporting the cause; the tick owns the row.
          options.emit?.({ kind: "board.dispatch-failed", task: releaseClaim(claimed.id) });
          continue;
        }
        if (!started) {
          // The world changed between canDispatch and the claim. No turn
          // started, so the attempt is refunded with the claim — otherwise
          // the give-up pass counts attempts that never happened.
          releaseClaim(claimed.id);
          continue;
        }
        slots -= 1;
        const withThread = attachThread(claimed.id, started.threadId);
        options.emit?.({ kind: "board.claimed", task: withThread });
      }
    } finally {
      ticking = false;
    }
  }

  function start(): void {
    if (timer) return;
    void tick();
    timer = setInterval(() => void tick(), TICK_MS);
    timer.unref?.();
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { tick, start, stop };
}
