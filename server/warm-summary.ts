// Warm summary: a long conversation is summarized while it sits idle and its prompt cache is still warm, so the next turn
// starts small and fast instead of summarizing on the person's time.
//
// Measured on a Team trial (_plans/team-trial-fixes-2026-10-30/FIRST-ANSWER.md): every first answer slower than 35 s was
// Claude Code compacting a conversation of about 162k tokens at the start of the person's turn (35 to 58 s), whatever the
// cache. A summary written in the idle gap after the turn before takes that off the person's wait.
//
// After a turn that leaves a conversation big enough, a summary is due a few minutes later (sooner when the next turn would
// summarize anyway). It is skipped while background work is about to wake the conversation, retried while the bot is busy,
// and given up once the cache has gone cold. A turn that starts meanwhile wins: the summary is abandoned, except when that
// turn would summarize at its start anyway, which then waits for the summary already being written rather than start its own.
// How a summary is written (the engine's own compaction on a fork of its session, or OpenMausBot's fold) and what it keeps
// word for word belong to the host: server/host/warm-summary-host.ts.

/** Below this a conversation's turns stay fast and cheap enough without a summary, and summarizing would only lose detail. */
export const WARM_SUMMARY_MIN_TOKENS = 100_000;
/** Idle this long after a turn: long enough that a quick reply is not raced, well inside a 5-minute API-key cache. */
export const WARM_SUMMARY_IDLE_MS = 3 * 60_000;
/** When the next turn would summarize at its start anyway: start almost at once. */
export const WARM_SUMMARY_SOON_MS = 10_000;
/** A busy bot, or a routine about to run: look again this much later. */
export const WARM_SUMMARY_RETRY_MS = 2 * 60_000;
/** A subscription's prompt cache lives an hour from the last request: after this the summary would write it all again. */
export const WARM_SUMMARY_GIVE_UP_MS = 50 * 60_000;
/** The longest a turn waits for a summary that it would otherwise have to write itself. */
export const WARM_SUMMARY_TURN_WAIT_MS = 3 * 60_000;

export interface WarmSummaryTarget {
  threadId: string;
  botId: string;
  instanceId: string;
}

/** `native`: the engine's own compaction (Claude Code's /compact on a fork); `harness`: OpenMausBot's fold, for engines
 * whose context it rebuilds. `soon`: the next turn would summarize at its start anyway. */
export interface WarmSummaryPlan {
  way: "native" | "harness";
  soon: boolean;
}

export type WarmSummaryOutcome = { ok: true } | { ok: false; reason: string; retry?: boolean };

export interface WarmSummaryDeps {
  now(): number;
  /** The delays before and between attempts are multiplied by this (a test fixture's way to run them in seconds); 1 by
   * default. The cap on a turn's wait is not: it bounds what a person waits for. */
  timeScale?: number;
  after(ms: number, fn: () => void): { cancel(): void };
  /** Whether and how this conversation gets a warm summary after a turn; null: not this one. */
  plan(target: WarmSummaryTarget, contextTokens: number | undefined): WarmSummaryPlan | null;
  /** Why not now. `retry`: it may pass in minutes (a busy bot, a routine due); otherwise the next turn here arms it again. */
  hold(target: WarmSummaryTarget): { reason: string; retry: boolean } | null;
  /** Writes and applies the summary. `awaited()`: a turn is waiting for it, so the turn's own setup is no reason to drop it. */
  run(target: WarmSummaryTarget, plan: WarmSummaryPlan, control: { signal: AbortSignal; awaited(): boolean }): Promise<WarmSummaryOutcome>;
  log?(line: string): void;
}

interface Run {
  controller: AbortController;
  done: Promise<void>;
  awaited: boolean;
}

interface Pending {
  target: WarmSummaryTarget;
  plan: WarmSummaryPlan;
  turnEndedAt: number;
  dueAt: number | null;
  timer: { cancel(): void } | null;
  run: Run | null;
}

export interface WarmSummaryState {
  plan: WarmSummaryPlan;
  dueAt: number | null;
  running: boolean;
  last?: { at: number; outcome: string };
}

export function createWarmSummary(deps: WarmSummaryDeps) {
  const scale = deps.timeScale && deps.timeScale > 0 && deps.timeScale <= 1 ? deps.timeScale : 1;
  const [idleMs, soonMs, retryMs, giveUpMs] = [WARM_SUMMARY_IDLE_MS, WARM_SUMMARY_SOON_MS, WARM_SUMMARY_RETRY_MS, WARM_SUMMARY_GIVE_UP_MS]
    .map((ms) => Math.max(1, Math.round(ms * scale)));
  const pending = new Map<string, Pending>();
  const last = new Map<string, { at: number; outcome: string }>();
  let disposed = false;

  const note = (threadId: string, outcome: string) => {
    last.set(threadId, { at: deps.now(), outcome });
    if (last.size > 500) last.delete(last.keys().next().value!);
    deps.log?.(`warm summary ${threadId}: ${outcome}`);
  };

  const drop = (p: Pending, outcome?: string) => {
    p.timer?.cancel();
    p.timer = null;
    p.dueAt = null;
    if (pending.get(p.target.threadId) === p) pending.delete(p.target.threadId);
    if (outcome) note(p.target.threadId, outcome);
  };

  const schedule = (p: Pending, ms: number) => {
    p.timer?.cancel();
    p.dueAt = deps.now() + ms;
    p.timer = deps.after(ms, () => { void fire(p); });
  };

  const fire = async (p: Pending): Promise<void> => {
    p.timer = null;
    p.dueAt = null;
    if (disposed || pending.get(p.target.threadId) !== p || p.run) return;
    if (deps.now() - p.turnEndedAt >= giveUpMs) return drop(p, "skipped: the prompt cache has gone cold");
    const held = deps.hold(p.target);
    if (held) {
      if (held.retry && deps.now() + retryMs - p.turnEndedAt < giveUpMs) {
        note(p.target.threadId, `waiting: ${held.reason}`);
        return schedule(p, retryMs);
      }
      return drop(p, `skipped: ${held.reason}`);
    }
    const controller = new AbortController();
    const run: Run = { controller, awaited: false, done: Promise.resolve() };
    p.run = run;
    run.done = (async () => {
      let outcome: WarmSummaryOutcome;
      try {
        outcome = await deps.run(p.target, p.plan, { signal: controller.signal, awaited: () => run.awaited });
      } catch (error) {
        outcome = { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
      if (p.run === run) p.run = null;
      if (pending.get(p.target.threadId) !== p) return;
      if (outcome.ok) return drop(p, "summarized");
      if (outcome.retry && !controller.signal.aborted && deps.now() + retryMs - p.turnEndedAt < giveUpMs) {
        note(p.target.threadId, `waiting: ${outcome.reason}`);
        return schedule(p, retryMs);
      }
      drop(p, `${controller.signal.aborted ? "abandoned" : "failed"}: ${outcome.reason}`);
    })();
    await run.done;
  };

  return {
    /** A turn ended: arm a summary for its conversation when it qualifies, replacing any earlier one. */
    turnCompleted(target: WarmSummaryTarget, turn: { ok: boolean; contextTokens?: number }): void {
      if (disposed) return;
      const existing = pending.get(target.threadId);
      if (existing?.run) return;
      if (existing) drop(existing);
      if (!turn.ok) return;
      const plan = deps.plan(target, turn.contextTokens);
      if (!plan) return;
      const p: Pending = { target, plan, turnEndedAt: deps.now(), dueAt: null, timer: null, run: null };
      pending.set(target.threadId, p);
      schedule(p, plan.soon ? soonMs : idleMs);
    },

    /** A turn began on this conversation: what the summary would cover is no longer the whole of it. */
    turnStarted(threadId: string): void {
      const p = pending.get(threadId);
      if (!p) return;
      if (p.run && !p.run.awaited) {
        deps.log?.(`warm summary ${threadId}: a turn started while it was being written`);
        p.run.controller.abort();
      }
      if (!p.run) drop(p);
    },

    /** Called by a turn's setup before it reads its session: waits for a summary the turn would otherwise write at its start,
     * and abandons any other, so the turn never waits for a summary it did not need. */
    async beforeTurn(threadId: string, stillWanted: () => boolean = () => true): Promise<"none" | "abandoned" | "waited" | "gave-up"> {
      const p = pending.get(threadId);
      if (!p) return "none";
      if (!p.run) {
        drop(p);
        return "none";
      }
      const run = p.run;
      if (!p.plan.soon) {
        deps.log?.(`warm summary ${threadId}: a turn that does not need it starts now`);
        run.controller.abort();
        return "abandoned";
      }
      deps.log?.(`warm summary ${threadId}: a turn waits for it`);
      run.awaited = true;
      const deadline = deps.now() + WARM_SUMMARY_TURN_WAIT_MS;
      let settled = false;
      void run.done.then(() => { settled = true; });
      while (!settled && stillWanted() && deps.now() < deadline) {
        await Promise.race([run.done, new Promise((resolve) => setTimeout(resolve, 250))]);
      }
      if (settled) return "waited";
      run.controller.abort();
      return "gave-up";
    },

    /** The person has this conversation in front of them: a summary the next turn would need anyway starts now. */
    seen(threadId: string): void {
      const p = pending.get(threadId);
      if (!p || p.run || !p.plan.soon || !p.timer) return;
      p.timer.cancel();
      void fire(p);
    },

    forget(threadId: string): void {
      const p = pending.get(threadId);
      if (!p) return;
      p.run?.controller.abort();
      drop(p);
    },

    forgetBot(botId: string): void {
      for (const p of pending.values()) if (p.target.botId === botId) { p.run?.controller.abort(); drop(p); }
    },

    state(threadId: string): WarmSummaryState | undefined {
      const p = pending.get(threadId);
      const done = last.get(threadId);
      if (!p) return done ? { plan: { way: "native", soon: false }, dueAt: null, running: false, last: done } : undefined;
      return { plan: p.plan, dueAt: p.dueAt, running: Boolean(p.run), ...(done ? { last: done } : {}) };
    },

    dispose(): void {
      disposed = true;
      for (const p of pending.values()) {
        p.timer?.cancel();
        p.run?.controller.abort();
      }
      pending.clear();
    },
  };
}

export type WarmSummaries = ReturnType<typeof createWarmSummary>;
