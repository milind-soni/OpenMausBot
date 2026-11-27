// Warm summaries for direct conversations (server/warm-summary.ts decides when): what may delay one, how each engine
// writes one, and what the conversation keeps word for word afterwards.
//
// - Claude Code (`cacheKeepWarm.compact`): its own /compact on a fork of the session, launched like the live process so
//   it reads the warm cache and the conversation keeps its tool list. The conversation then moves to the fork, and its
//   last two exchanges count as not yet seen by it, so the next turn carries them word for word on OpenMausBot's existing
//   "not seen yet" path, which is saved with the conversation and survives a restart.
// - Every other engine: OpenMausBot's own fold (the last two exchanges kept, the rest summarized), run now rather than at
//   the next turn's start, once the conversation is close to where that turn would fold it.
//
// The person sees it the way they see compaction today: one activity line for Claude Code's summary, the summary note for
// OpenMausBot's fold.
import type { EngineCompactResult, IdleCompactResult } from "../contracts.ts";
import { isContextMessage, type HandedState } from "../delta-context.ts";
import { sinceFreshStart } from "../fresh-start.ts";
import { backgroundTextSlots, type JobSlots } from "../job-slots.ts";
import { wakeHoldOf } from "../routine-due.ts";
import type { Routine, RoutineRun } from "../routines.ts";
import { serverLine } from "../server-lines.ts";
import type { Message, Store } from "../store.ts";
import type { WaitRecord } from "../waits.ts";
import { createWarmSummary, WARM_SUMMARY_MIN_TOKENS, WARM_SUMMARY_RETRY_MS, type WarmSummaryOutcome, type WarmSummaryPlan, type WarmSummaryTarget } from "../warm-summary.ts";

/** Claude Code 2.1.321 summarizes about this far below its compaction window: near 167k with `--autocompact 200000`
 * (162k was measured on a Team trial), and before 74k with 100000. */
export const NATIVE_COMPACT_HEADROOM = 33_000;
/** Within this of that point the next turn would summarize anyway: 160k at the default. */
export const NATIVE_SOON_MARGIN = 7_000;
/** Within this of that point an ordinary turn of tool work can end past it (one whole-file read adds about 22k): 140k at
 * the default. */
export const NATIVE_AHEAD_MARGIN = 27_000;
/** The line Claude Code's own PreCompact hook puts in the chat; a turn waiting for a summary shows the same one. */
export const COMPACTION_STARTED_LINE = "context compaction started (auto)";
/** Kept word for word after a summary: the person's last two messages and everything since. */
export const KEPT_EXCHANGES = 2;
/** OpenMausBot's fold runs while idle once a conversation is this close to where the next turn would fold it. */
export const HARNESS_IDLE_FRACTION = 0.85;
/** While the person has a conversation in front of them, its engine process is kept this long past their last activity. */
export const PRESENCE_HOLD_MS = 10 * 60_000;

type CompactFn = (threadId: string, options: { instructions: string; session?: string; signal?: AbortSignal }) => Promise<IdleCompactResult>;

/** What an engine's compaction asked for by the person is checked against, before it and once it is done. */
export interface EngineCompactCheck {
  /** The model selection the conversation's next turn runs on. */
  model: string;
  /** The person set `context.compactAt`: an engine that compacts in place leaves compacting to the fold. */
  compactAtSet: boolean;
  /** Whether the next turn would carry on `session` rather than rebuild from the transcript. */
  resumes(session: string): boolean;
  /** The engine instance and model the next turn would run on now. */
  selectionNow(): { instanceId: string; model: string | null } | undefined;
  /** The turn that holds the conversation for this compaction still does. */
  current(): boolean;
}

/** `skipped`: the engine did nothing or failed, and the caller folds. `done`: the session is compacted. `stale`: the engine
 * compacted, but the conversation moved on while it did, so nothing is written and nothing folds. */
export type EngineCompactOutcome = "skipped" | "done" | "stale";

export interface WarmSummaryHostDeps {
  /** How many background engine jobs run at once, across bots (job-slots.ts). */
  slots?: JobSlots;
  store: Pick<Store, "taskByThread" | "botByThread" | "groupByThread" | "activePath" | "appendMessage" | "setResumeCursor" | "setHandedMessages" | "patchTask">;
  instance(instanceId: string): { adapter: { cacheKeepWarm?: { compact?: CompactFn; hold(threadId: string, until: number | null): boolean };
    compactSession?(threadId: string, options: { botId?: string; session: string; model?: string | null; selectionNow?: EngineCompactCheck["selectionNow"]; signal?: AbortSignal }): Promise<EngineCompactResult> } } | null | undefined;
  /** Off with `context.autoCompact: false` or OMB_WARM_SUMMARY=0. */
  enabled(): boolean;
  /** Where the engine summarizes by itself, in tokens (Claude Code's --autocompact); undefined when OpenMausBot set none. */
  nativeCompactAt(target: WarmSummaryTarget): number | undefined;
  /** A turn is running or being set up in this conversation, or the bot is busy elsewhere. */
  busy(botId: string, threadId: string): boolean;
  memoryShort(): boolean;
  /** What can wake a conversation without the person: a queued message, a teammate's answer, a wait, a routine. */
  queued(botId: string, threadId: string): boolean;
  coordinator: { activeDirect(threadId: string): boolean; awaitingTeammateThreads(): Set<string> };
  waits(): { all(): WaitRecord[] } | null;
  routines(): { listRoutines(): Routine[]; listRuns(): RoutineRun[] } | null;
  /** OpenMausBot's fold, now: true when it wrote a summary, false when the conversation does not need one yet. */
  fold(target: WarmSummaryTarget, signal: AbortSignal): Promise<boolean>;
  /** The summary call's usage, booked like a keep-warm ping. */
  book(target: WarmSummaryTarget, result: Extract<IdleCompactResult, { ok: true }>): void;
  /** An engine's in-place compaction's usage; with none reported, a row whose tokens are marked unreported. */
  bookEngineCompact(target: WarmSummaryTarget, result: Extract<EngineCompactResult, { ok: true }>): void;
  /** Until when keep-warm already holds this conversation's process. */
  keepWarmUntil(threadId: string): number | undefined;
  /** The language the conversation's person reads its lines in (server/server-lines.ts); undefined reads as English. */
  language?(threadId: string): string | undefined;
  now?(): number;
  after?(ms: number, fn: () => void): { cancel(): void };
  log?(line: string): void;
}

/** What the summary must keep: questions still waiting and the person's own words for what is current. */
export function summaryInstructions(messages: readonly Message[]): string {
  const open = messages.filter((m) => m.kind === "options" && m.card?.requestType === "question" && !m.card.answered &&
    !m.card.dismissed && !m.card.expired && !m.card.stopped)
    .map((m) => [m.card!.title, m.card!.subtitle].filter((part) => part?.trim()).join(": ").replace(/\s+/g, " ").trim().slice(0, 300))
    .filter(Boolean).slice(-5);
  return [
    "Keep the person's latest requests, corrections and decisions in their own words, and every question still waiting for an answer, theirs and yours.",
    "Say which work is finished and which is still open.",
    ...(open.length ? [`Questions waiting for the person: ${open.map((q) => `"${q}"`).join("; ")}.`] : []),
  ].join(" ");
}

/** The handed state after a summary: the session holds everything before the last `KEPT_EXCHANGES` exchanges (in summary),
 * and those count as not seen yet, so the next turn sends them word for word. `exchanges`: how many were kept. */
export function keptAfterSummary(messages: readonly Message[], session: string, before: HandedState | undefined): { state: HandedState; exchanges: number } {
  const context = messages.filter(isContextMessage);
  const users = context.flatMap((m, index) => m.role === "user" ? [index] : []);
  const cut = users.length >= KEPT_EXCHANGES ? users[users.length - KEPT_EXCHANGES]! : 0;
  const through = cut > 0 ? context[cut - 1]!.id : undefined;
  const state: HandedState = {
    session,
    ...(before?.config !== undefined ? { config: before.config } : {}),
    ...(before?.effort !== undefined ? { effort: before.effort } : {}),
    ...(through !== undefined ? { through } : {}),
    ids: [],
  };
  return { state, exchanges: through === undefined ? users.length : KEPT_EXCHANGES };
}


export function createWarmSummaryHost(deps: WarmSummaryHostDeps) {
  const { store } = deps;
  const now = deps.now ?? Date.now;

  const native = async (target: WarmSummaryTarget, control: { signal: AbortSignal; awaited(): boolean }, askedByPerson = false): Promise<WarmSummaryOutcome> => {
    const { threadId, botId, instanceId } = target;
    const compact = deps.instance(instanceId)?.adapter.cacheKeepWarm?.compact;
    const session = store.taskByThread(botId, threadId)?.resumeCursors[instanceId];
    if (!compact || typeof session !== "string") return { ok: false, reason: "the conversation has no session to summarize" };
    const result = await compact(threadId, { instructions: summaryInstructions(sinceFreshStart(store.activePath(threadId))), session, signal: control.signal });
    if (!result.ok) return { ok: false, reason: result.reason, retry: result.busy === true && !control.signal.aborted };
    deps.book(target, result);
    // Applied only to the conversation as it was: on the same session, and with no turn begun since (but the one waiting).
    const task = store.taskByThread(botId, threadId);
    if (task?.resumeCursors[instanceId] !== result.sessionBefore) return { ok: false, reason: "the conversation moved to another session" };
    if (control.signal.aborted || (!control.awaited() && deps.busy(botId, threadId))) return { ok: false, reason: "a turn started while summarizing" };
    const { state, exchanges } = keptAfterSummary(sinceFreshStart(store.activePath(threadId)), result.session, task.handedMessages?.[instanceId]);
    store.setResumeCursor(botId, instanceId, result.session, threadId);
    store.setHandedMessages(botId, threadId, instanceId, state);
    store.appendMessage(threadId, askedByPerson ? { role: "bot", kind: "compaction", engineCompaction: true }
      : { role: "bot", kind: "activity", tool: { name: serverLine(deps.language?.(threadId), "server.warmSummary.summarized"), ok: true } });
    deps.log?.(`${askedByPerson ? "compact now" : "warm summary"} ${threadId}: moved to its summarized session, keeping ${exchanges} exchange(s) word for word`);
    return { ok: true };
  };

  const compactInPlace = async (target: WarmSummaryTarget, session: string, check: EngineCompactCheck, signal: AbortSignal): Promise<EngineCompactOutcome> => {
    const { threadId, botId, instanceId } = target;
    const result = await deps.instance(instanceId)!.adapter.compactSession!(threadId, { botId, session, model: check.model, selectionNow: check.selectionNow, signal });
    if (!result.ok) {
      deps.log?.(`compact now ${threadId}: not by the engine (${result.reason})`);
      return "skipped";
    }
    deps.bookEngineCompact(target, { ...result, model: result.model ?? check.model });
    const now = check.selectionNow();
    if (store.taskByThread(botId, threadId)?.resumeCursors[instanceId] !== session || !check.current() || signal.aborted || now?.instanceId !== instanceId || now.model !== check.model || !check.resumes(session)) {
      deps.log?.(`compact now ${threadId}: the engine compacted, but the conversation moved on meanwhile`);
      return "stale";
    }
    const task = store.taskByThread(botId, threadId);
    store.patchTask(botId, threadId, { lastContextModel: undefined, ...(task?.usage ? { usage: { ...task.usage, context: undefined } } : {}) });
    store.appendMessage(threadId, { role: "bot", kind: "compaction", engineCompaction: true });
    deps.log?.(`compact now ${threadId}: compacted in place by the engine`);
    return "done";
  };

  const warm = createWarmSummary({
    now,
    timeScale: Number(process.env.OMB_WARM_SUMMARY_TIME_SCALE) || 1,
    after: deps.after ?? ((ms, fn) => { const timer = setTimeout(fn, ms); timer.unref?.(); return { cancel: () => clearTimeout(timer) }; }),
    plan: (target, contextTokens): WarmSummaryPlan | null => {
      if (!deps.enabled() || store.groupByThread(target.threadId) || !store.taskByThread(target.botId, target.threadId)) return null;
      const instance = deps.instance(target.instanceId);
      if (!instance) return null;
      if (!instance.adapter.cacheKeepWarm?.compact) return { way: "harness", soon: false };
      const at = deps.nativeCompactAt(target);
      if (at === undefined || contextTokens === undefined || contextTokens < Math.min(WARM_SUMMARY_MIN_TOKENS, at / 2)) return null;
      const point = at - NATIVE_COMPACT_HEADROOM;
      return { way: "native", soon: contextTokens >= point - NATIVE_SOON_MARGIN, ahead: contextTokens >= point - NATIVE_AHEAD_MARGIN };
    },
    hold: ({ botId, threadId }) => {
      if (deps.busy(botId, threadId)) return { reason: "the bot is busy", retry: true };
      if (deps.memoryShort()) return { reason: "memory is short", retry: true };
      if (deps.queued(botId, threadId)) return { reason: "a message is waiting for this conversation", retry: false };
      if (deps.coordinator.activeDirect(threadId) || deps.coordinator.awaitingTeammateThreads().has(threadId)) {
        return { reason: "a teammate is working on this conversation's request", retry: false };
      }
      if (deps.waits()?.all().some((w) => w.botId === botId && w.threadId === threadId && w.followUp !== undefined && w.ending?.status === "fired")) {
        return { reason: "a wait has fired and will carry on here", retry: false };
      }
      const routines = deps.routines();
      if (routines && wakeHoldOf(routines.listRoutines().filter((r) => r.botId === botId), routines.listRuns().filter((r) => r.botId === botId), now(), WARM_SUMMARY_RETRY_MS).hold) {
        return { reason: "a routine of this bot is about to run", retry: true };
      }
      return null;
    },
    // Each summary is an engine process (a fork, or the one-shot summary call): a few at once across bots, and one a turn
    // now waits on starts at once. One that had to wait looks again: the cache may have gone cold, or a turn begun, meanwhile.
    run: (target, plan, control) => {
      let waited = false;
      return (deps.slots ?? backgroundTextSlots).run(async () => {
        const stale = waited && !control.awaited() ? control.stale() : null;
        if (stale) return { ok: false, reason: `${stale.reason} (after waiting for a free slot)`, retry: stale.retry };
        if (plan.way === "native") return native(target, control);
        return await deps.fold(target, control.signal) ? { ok: true } : { ok: false, reason: "the conversation does not need a summary yet" };
      }, { signal: control.signal, urgent: control.awaited, onWait: () => { waited = true; } });
    },
    waiting: ({ threadId }) => { store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: COMPACTION_STARTED_LINE, ok: true } }); },
    log: deps.log,
  });

  return {
    ...warm,
    /** The person asked for a summary now: the engine's own compaction of the conversation's session, where the engine has
     * one to run outside a turn, and only on a session the conversation's next turn would carry on. `skipped` leaves the
     * conversation as it was. */
    async compactNow(target: WarmSummaryTarget, signal: AbortSignal, check: EngineCompactCheck): Promise<EngineCompactOutcome> {
      warm.forget(target.threadId);
      const session = store.taskByThread(target.botId, target.threadId)?.resumeCursors[target.instanceId];
      if (typeof session === "string" && !check.resumes(session)) {
        deps.log?.(`compact now ${target.threadId}: not by the engine (the next turn would not carry on its session)`);
        return "skipped";
      }
      if (typeof session === "string" && deps.instance(target.instanceId)?.adapter.compactSession) {
        if (check.compactAtSet) {
          deps.log?.(`compact now ${target.threadId}: not by the engine (context.compactAt is set, so the fold compacts)`);
          return "skipped";
        }
        return compactInPlace(target, session, check, signal);
      }
      const outcome = await native(target, { signal, awaited: () => true }, true);
      if (!outcome.ok) deps.log?.(`compact now ${target.threadId}: not by the engine (${outcome.reason})`);
      return outcome.ok ? "done" : "skipped";
    },
    /** The person has the conversation in front of them (opened it, or is active in the app with it open). */
    sawThread(threadId: string): void {
      warm.seen(threadId);
      const bot = store.botByThread(threadId);
      const instanceId = bot ? store.taskByThread(bot.id, threadId)?.lastInstanceId : undefined;
      const hold = instanceId ? deps.instance(instanceId)?.adapter.cacheKeepWarm?.hold : undefined;
      if (hold) hold(threadId, Math.max(now() + PRESENCE_HOLD_MS, deps.keepWarmUntil(threadId) ?? 0));
    },
  };
}

export type WarmSummaryHost = ReturnType<typeof createWarmSummaryHost>;
