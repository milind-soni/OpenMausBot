// The last gap in the board's crash-recovery core: task-dispatcher.ts
// promotes, claims, reclaims, and gives up, but nothing ever heartbeats a
// dispatched task while its turn runs, and nothing settles it when the turn
// ends. Left alone, a dispatched task whose turn SUCCEEDS still goes cold
// under staleRunning, gets reclaimed, retried, and eventually blocked —
// exactly as if it had crashed.
//
// This module is the observer that closes that gap. It watches a
// dispatched task's turn on the harness's own runtime event stream
// (server/index.ts's `bus`, RuntimeEvent from contracts.ts) and:
//   - heartbeats the task on every sign the turn is still doing something —
//     item.started/completed, content.delta, thread.token-usage.updated,
//     turn.retrying, request.opened/resolved, session.started all only fire
//     while a real turn is actually producing something, which is why the
//     event stream is the PRIMARY, honest signal of "still alive".
//   - backs that up with a BOUNDED keepalive, for the case a turn is
//     genuinely alive but quiet for longer than the event stream happens to
//     promise (one long tool call with no intervening progress event).
//     Three conditions keep that timer honest, and it stops beating the
//     moment any of them stops holding:
//       1. a silence budget (maxSilentMs), refreshed by REAL event activity
//          and by nothing else. A turn that emits nothing at all can only be
//          carried for that long; after it the keepalive goes quiet and
//          staleRunning is free to reclaim the task. Without this bound, any
//          path where a watched turn never emits turn.completed or
//          session.exited (a dispatch that fails inside server/index.ts's
//          un-awaited setup IIFE, say) left a timer heartbeating the task
//          for the life of the process — the task holding a concurrency slot
//          in "running" forever, unreclaimable.
//       2. the harness's own opinion (isThreadAlive, wired to
//          server/index.ts's threadBusy): beat only while the harness agrees
//          that thread is actually working.
//       3. the attempt it was armed for still being the task's current one
//          (see the attempts fence below).
//     If the process dies, the timer dies with it — nothing survives a
//     crash, so the crash path (nobody left to heartbeat, event-driven or
//     otherwise) still works exactly as before.
//   - settles the task the instant the turn ends: review on success,
//     blocked (with the failure recorded, redacted) otherwise. fail() is the
//     same settle for a dispatch that failed without ever emitting anything.
//
// The attempts fence: a watch remembers the task's `attempts` at watch()
// time. A reclaim (or a human moving the task back to ready) re-dispatches
// it under a NEW attempt and a new thread; the OLD turn's terminal event can
// still arrive afterwards, and settling on it would be a perfectly legal
// running -> review move — marking the NEW attempt finished while its turn
// is still running, and swallowing the real result. So every beat and every
// settle first checks that the task's current attempts still match the ones
// this watch was armed for, and a superseded watch is forgotten instead.
// watch() is additionally keyed by taskId as well as threadId, so
// re-dispatching a task tears down its previous watch rather than stacking
// a second one on the same task.
//
// What is unchanged, deliberately: task-board.ts's TRANSITIONS and
// task-dispatcher.ts's staleRunning/reclaim/give-up/promote/claim ordering.
// This module only ever calls the existing heartbeat()/setStatus() — it is
// a client of the safety net, never a change to it.
import { redactSecretsInText } from "./redact.ts";
import { getTask, heartbeat, setStatus } from "./task-board.ts";

/** How long the keepalive alone may carry a turn that emits nothing at all.
 * Real events refresh it; silence spends it. Generous enough for a long
 * quiet tool call, finite enough that a wedged turn is reclaimable inside a
 * quarter of an hour instead of never. */
export const DEFAULT_MAX_SILENT_MS = 900_000;

/** The slice of RuntimeEvent this module reacts to. Kept narrow (rather
 * than importing the full RuntimeEvent union from contracts.ts) so tests
 * can construct fixtures without every field a real provider event carries
 * — a real RuntimeEvent satisfies this shape structurally, so the harness
 * can pass one straight through with no adapter. */
export interface TurnLifecycleEvent {
  type: string;
  threadId: string;
  /** Present (and meaningful) only on "turn.completed". */
  ok?: boolean;
  /** Present (and meaningful) only on "turn.completed". */
  stopReason?: string | null;
}

export interface TaskTurnWatchOptions {
  /** The stale threshold this watch is protecting a quiet-but-live turn
   * against; the keepalive ticks at a third of it. REQUIRED, with no
   * default on purpose: the watch and the dispatcher must be given the same
   * number by one caller (server/index.ts resolves it once and passes it to
   * both). A watch beating against a window the dispatcher no longer uses
   * would let live turns be reclaimed and re-run. */
  staleAfterMs: number;
  /** How long the keepalive may carry a turn with no event activity at all.
   * Defaults to DEFAULT_MAX_SILENT_MS. */
  maxSilentMs?: number;
  /** Injectable clock so tests never sleep for real. */
  now?: () => number;
  /** The harness's own view of whether that thread is still working
   * (server/index.ts's threadBusy). The keepalive stops beating the moment
   * this reads false: a heartbeat is a claim that the turn is alive, and
   * this module must not make that claim on its own authority. Only
   * consulted when watch() was given a botId. */
  isThreadAlive?: (botId: string, threadId: string) => boolean;
}

export interface TaskTurnWatch {
  /** Start watching a dispatched task's turn. Call it right BEFORE the turn
   * is started, so a dispatch that fails during setup can still be settled
   * through fail() — the task is already claimed ("running") by then, so
   * there is no window in which it is claimed but unwatched. Any previous
   * watch for the same task (or the same thread) is torn down first. */
  watch(taskId: string, threadId: string, opts?: { botId?: string }): void;
  /** Feed the watch one runtime event. Events for a threadId nobody is
   * watching are ignored — cheap enough to call unconditionally for every
   * event on the bus. */
  handle(event: TurnLifecycleEvent): void;
  /** The turn never started (startTurn threw, the setup was cancelled):
   * settle the task to blocked now rather than leaving it to a stale sweep
   * three minutes later. */
  fail(threadId: string, reason: string): void;
  /** Forget a watch without settling the task — for a watch armed for a
   * turn that then failed to start at all, where the caller is putting the
   * claim back itself. */
  unwatch(taskId: string): void;
  /** Stop every keepalive timer and forget every watched task, without
   * settling any of them — process shutdown, or a test standing in for
   * "the process died mid-turn". */
  stopAll(): void;
}

interface Watched {
  taskId: string;
  threadId: string;
  botId?: string;
  /** The task's attempts at watch() time — the fence that proves a terminal
   * signal belongs to THIS attempt and not one the board has superseded. */
  attempts: number;
  /** Absolute instant the keepalive stops carrying a silent turn. */
  silentUntil: number;
  keepalive: ReturnType<typeof setInterval> | null;
}

export function createTaskTurnWatch(options: TaskTurnWatchOptions): TaskTurnWatch {
  const staleAfterMs = options.staleAfterMs;
  const maxSilentMs = options.maxSilentMs ?? DEFAULT_MAX_SILENT_MS;
  const now = options.now ?? Date.now;
  const isThreadAlive = options.isThreadAlive;
  // A third of the stale threshold: comfortably often enough that a quiet
  // (but alive) turn's heartbeat is never more than one keepalive tick
  // away from fresh, with margin against a busy event loop delaying a
  // given tick. Never below a 1s floor even if staleAfterMs is configured
  // absurdly small (a test, say) — a zero or negative interval would spin.
  const keepaliveMs = Math.max(1000, Math.floor(staleAfterMs / 3));
  const byTask = new Map<string, Watched>();
  const byThread = new Map<string, Watched>();

  function forget(entry: Watched): void {
    if (entry.keepalive) clearInterval(entry.keepalive);
    entry.keepalive = null;
    if (byTask.get(entry.taskId) === entry) byTask.delete(entry.taskId);
    if (byThread.get(entry.threadId) === entry) byThread.delete(entry.threadId);
  }

  function quiet(entry: Watched): void {
    // Stop asserting liveness, keep listening. The task is left for
    // staleRunning to reclaim on its own schedule, and a terminal event that
    // does eventually arrive can still settle it.
    if (entry.keepalive) clearInterval(entry.keepalive);
    entry.keepalive = null;
  }

  /** Is this watch still the board's current attempt on that task? A watch
   * whose attempt was superseded (reclaimed and re-claimed) is forgotten
   * outright: nothing it could do now would be about the live turn. */
  function current(entry: Watched): boolean {
    const task = getTask(entry.taskId);
    if (task && task.attempts === entry.attempts) return true;
    forget(entry);
    return false;
  }

  function beat(entry: Watched): boolean {
    if (!current(entry)) return false;
    try {
      heartbeat(entry.taskId);
    } catch {
      // The task moved on without us — already reclaimed by a stale sweep,
      // or edited/settled by a human in the meantime. Nothing left here to
      // keep alive.
      return false;
    }
    return true;
  }

  function arm(entry: Watched): void {
    if (entry.keepalive) return;
    const keepalive = setInterval(() => {
      // Bounded: a turn that has emitted nothing for its whole silence
      // budget is no longer evidence of anything, so stop claiming it is.
      if (now() >= entry.silentUntil) return quiet(entry);
      // Honest: the harness is the authority on whether that thread is
      // working. When it says no, this timer has nothing to attest to.
      if (entry.botId && isThreadAlive && !isThreadAlive(entry.botId, entry.threadId)) return quiet(entry);
      beat(entry);
    }, keepaliveMs);
    keepalive.unref?.();
    entry.keepalive = keepalive;
  }

  function watch(taskId: string, threadId: string, opts: { botId?: string } = {}): void {
    // Defensive on both keys: a reused threadId must never double-watch, and
    // re-dispatching a task must never leave two entries pointing at it (the
    // older one would settle the newer attempt when its own turn ended).
    const priorTask = byTask.get(taskId);
    if (priorTask) forget(priorTask);
    const priorThread = byThread.get(threadId);
    if (priorThread) forget(priorThread);
    const entry: Watched = {
      taskId,
      threadId,
      botId: opts.botId,
      attempts: getTask(taskId)?.attempts ?? 0,
      silentUntil: now() + maxSilentMs,
      keepalive: null,
    };
    byTask.set(taskId, entry);
    byThread.set(threadId, entry);
    // The claim that led here already stamped heartbeat_at (task-board.ts's
    // claimTask), but beating again here costs nothing and covers the gap
    // between that claim and the turn's first real event or keepalive tick.
    if (beat(entry)) arm(entry);
  }

  function settle(entry: Watched, ok: boolean, reason: string | undefined): void {
    // The fence: a terminal signal from an attempt the board has already
    // superseded must never move the task that replaced it.
    if (!current(entry)) return;
    forget(entry); // the keepalive must not outlive the turn it was covering
    try {
      if (ok) setStatus(entry.taskId, "review");
      else setStatus(entry.taskId, "blocked", { blockedReason: reason ?? "the turn did not finish" });
    } catch {
      // Already moved on: a human touched the task's status, or a stale
      // sweep put it back in the pool. This terminal signal arrived too late
      // to matter — never force a transition just because we remembered a
      // threadId no one asked us to forget.
    }
  }

  function handle(event: TurnLifecycleEvent): void {
    const entry = byThread.get(event.threadId);
    if (!entry) return;
    if (event.type === "turn.completed") {
      const ok = event.ok === true;
      settle(entry, ok, ok ? undefined : failureReason(event.stopReason));
      return;
    }
    if (event.type === "session.exited") {
      // A driver can exit without ever emitting turn.completed (the same
      // reason server/index.ts's memory-journal subscriber folds on both
      // events) — treat it as a failure rather than leaving the task
      // watched (and its keepalive ticking) forever with no more evidence
      // ever coming.
      settle(entry, false, "the bot's session exited before the turn finished");
      return;
    }
    // Real activity: the one thing that refreshes the silence budget, and
    // the one thing that may re-arm a keepalive that had gone quiet.
    if (!beat(entry)) return;
    entry.silentUntil = now() + maxSilentMs;
    arm(entry);
  }

  /** A provider's own words reach blocked_reason, which is persisted,
   * returned by GET /api/tasks, broadcast over SSE and read back to a bot by
   * task_list. Everything else in the harness redacts provider error text
   * before it travels that far; so does this. */
  function failureReason(stopReason: string | null | undefined): string {
    const text = stopReason?.trim();
    return text ? redactSecretsInText(text) : "the bot's turn ended without success";
  }

  function fail(threadId: string, reason: string): void {
    const entry = byThread.get(threadId);
    if (!entry) return;
    settle(entry, false, failureReason(reason));
  }

  function unwatch(taskId: string): void {
    const entry = byTask.get(taskId);
    if (entry) forget(entry);
  }

  function stopAll(): void {
    // Deleting the current entry mid-iteration over a Map is well-defined
    // (and does not skip the next one), so no snapshot is needed.
    for (const entry of byTask.values()) forget(entry);
  }

  return { watch, handle, fail, unwatch, stopAll };
}
