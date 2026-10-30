// A goal in a one-on-one chat, run as a room of one: the bot leads and does the work itself, one turn at a time.
import { randomUUID } from "node:crypto";

import { failedTurnTool } from "../../shared/failed-turn.ts";
import type { HostTurnResult } from "../coordinator.ts";
import { GROUP_GOAL_WAIT_MAX_MS, runGoalRun, type GoalRunEnd, type GoalStepOutcome, type GoalStepResult } from "../group-goal-run.ts";
import { OUTSIDE, workOrigin, type WorkOrigin } from "../peer-provenance.ts";
import type { BotRecord, Message, Store } from "../store.ts";
import type { GoalCards, LiveGoalRun } from "./goal-cards.ts";
import type { GoalTurns } from "./goal-turns.ts";

export interface OneOnOneGoalDeps {
  store: Pick<Store, "appendMessage" | "bot" | "onChange" | "taskByThread" | "titleTaskFromFirstMessage">;
  cards: GoalCards;
  turns: GoalTurns;
  /** startTurn would admit a turn in this conversation now. */
  canStart(botId: string, threadId: string): boolean;
  startTurn(botId: string, text: string, opts: {
    threadId: string;
    cardContinuation: true;
    requestMessageId: string;
    origin: WorkOrigin;
    unattended: boolean;
    onSettled: (outcome: HostTurnResult) => void;
  }): Promise<unknown>;
  isUnattended(botId: string, threadId: string): boolean;
}

export interface OneOnOneGoalStart {
  /** The routine run this goal is; it names the run, and its work is never the person's own request. */
  runId?: string;
  sendId?: string;
  sender?: Message["sender"];
}

type LiveGoal = {
  run: LiveGoalRun;
  botId: string;
  cancelled: boolean;
  wake?: () => void;
};

type Availability = "ready" | "cancelled" | "unavailable" | "timed_out";

const LOST_RACE_RETRY_MS = 250;

export function createOneOnOneGoals(deps: OneOnOneGoalDeps) {
  const { store } = deps;
  const live = new Map<string, LiveGoal>();

  function finish(threadId: string, goal: LiveGoal, status: GoalRunEnd, detail: string): void {
    deps.cards.finish(threadId, goal.run, status, detail, () => Boolean(store.taskByThread(goal.botId, threadId)));
  }

  function availability(goal: LiveGoal, botId: string, threadId: string): Availability | null {
    if (goal.cancelled) return "cancelled";
    if (!store.bot(botId) || !store.taskByThread(botId, threadId)) return "unavailable";
    return deps.canStart(botId, threadId) ? "ready" : null;
  }

  function waitUntilFree(goal: LiveGoal, bot: BotRecord, threadId: string): Promise<Availability> {
    const now = availability(goal, bot.id, threadId);
    if (now) return Promise.resolve(now);
    deps.cards.progress(threadId, goal.run, `${bot.name} is finishing what it is doing. This goal will continue when it is free.`);
    return new Promise((resolve) => {
      let settled = false;
      const check = () => {
        const next = availability(goal, bot.id, threadId);
        if (next) done(next);
      };
      const poll = setInterval(check, 1_000);
      poll.unref?.();
      const cap = setTimeout(() => done("timed_out"), GROUP_GOAL_WAIT_MAX_MS);
      cap.unref?.();
      const unsubscribe = store.onChange((change) => {
        if ((change.type === "bot" || change.type === "bot.deleted") && change.botId === bot.id) check();
      });
      function done(result: Availability) {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(cap);
        unsubscribe();
        goal.wake = undefined;
        resolve(result);
      }
      goal.wake = check;
    });
  }

  async function step(goal: LiveGoal, threadId: string, request: { id: string; origin: WorkOrigin }, bot: BotRecord, instructions: string): Promise<GoalStepResult> {
    const { run } = goal;
    for (;;) {
      if (goal.cancelled || run.turnCount >= run.maxTurns) return { ran: false, replyText: "" };
      const free = await waitUntilFree(goal, bot, threadId);
      if (free === "cancelled") return { ran: false, replyText: "", outcome: "cancelled" };
      if (free === "unavailable") return { ran: false, replyText: "", outcome: "unavailable", stopReason: `${bot.name} is no longer available` };
      if (free === "timed_out") {
        const minutes = Math.max(1, Math.round(GROUP_GOAL_WAIT_MAX_MS / 60_000));
        return { ran: false, replyText: "", outcome: "busy", stopReason: `${bot.name} stayed busy for ${minutes} minute${minutes === 1 ? "" : "s"}` };
      }
      let settle!: (outcome: HostTurnResult) => void;
      const settled = new Promise<HostTurnResult>((resolve) => { settle = resolve; });
      const lead = deps.turns.begin(threadId);
      let outcome: GoalStepOutcome | undefined;
      try {
        try {
          await deps.startTurn(bot.id, instructions, {
            threadId,
            cardContinuation: true,
            requestMessageId: request.id,
            origin: request.origin,
            unattended: deps.isUnattended(bot.id, threadId),
            onSettled: settle,
          });
        } catch (error) {
          const code = (error as { code?: unknown } | null)?.code;
          const message = error instanceof Error ? error.message : String(error);
          if (code === "thread_busy" || code === "thread_limit") {
            outcome = "busy";
            await new Promise((resolve) => setTimeout(resolve, LOST_RACE_RETRY_MS));
            continue;
          }
          if (code === "spend_cap") {
            store.appendMessage(threadId, { role: "bot", kind: "activity", tool: failedTurnTool(message) });
            outcome = "spend_capped";
          } else {
            outcome = "dispatch_failed";
          }
          return { ran: false, replyText: "", outcome, stopReason: message };
        }
        run.turnCount += 1;
        deps.cards.progress(threadId, run, `${bot.name} is working on turn ${run.turnCount} of ${run.maxTurns}.`);
        const result = await settled;
        if (goal.cancelled) {
          outcome = "cancelled";
          return { ran: false, replyText: "", outcome };
        }
        outcome = result.stalled ? "stalled" : result.ok ? "settled" : "provider_failed";
        return {
          ran: true,
          replyText: result.ok ? lead.assistantItems.join("\n") : "",
          outcome,
          ...(result.ok ? {} : { stopReason: result.text }),
        };
      } finally {
        deps.turns.end(threadId, lead, outcome);
      }
    }
  }

  /** Appends the person's goal line and its run card, then works until the bot reports an outcome or the turns run out. */
  function start(botId: string, threadId: string, text: string, options: OneOnOneGoalStart = {}): Message {
    const bot = store.bot(botId);
    if (!bot || !store.taskByThread(botId, threadId)) throw Object.assign(new Error("no such conversation"), { status: 404 });
    if (live.has(threadId)) {
      throw Object.assign(new Error("A goal is already running in this chat. Stop it before starting another."), { status: 409 });
    }
    const message = store.appendMessage(threadId, {
      role: "user",
      kind: "text",
      text,
      channelMode: "goal",
      ...(options.sendId ? { sendId: options.sendId } : {}),
      ...(options.sender ? { sender: options.sender } : {}),
    });
    store.titleTaskFromFirstMessage(botId, text, threadId);
    const goal: LiveGoal = {
      run: deps.cards.start(threadId, bot, text, options.runId ?? `goal-${Date.now().toString(36)}-${randomUUID()}`),
      botId,
      cancelled: false,
    };
    live.set(threadId, goal);
    const request = { id: message.id, origin: options.runId ? OUTSIDE : workOrigin(message) };
    void runGoalRun({
      run: goal.run,
      coordinator: bot,
      members: [bot],
      solo: true,
      cancelled: () => goal.cancelled,
      current: (id) => store.bot(id) ?? undefined,
      step: (member, _coordinator, instructions) => step(goal, threadId, request, member, instructions),
      finish: (status, detail) => finish(threadId, goal, status, detail),
      progress: (detail) => deps.cards.progress(threadId, goal.run, detail),
      note: (line) => store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: line, ok: false } }),
    })
      .catch((error: unknown) => finish(threadId, goal, "failed", error instanceof Error ? error.message : String(error)))
      .finally(() => {
        finish(threadId, goal, "failed", "The goal run ended before the bot reported an outcome.");
        if (live.get(threadId) === goal) live.delete(threadId);
      });
    return message;
  }

  /** Ends the run on its card at once; the turn in flight is the caller's to interrupt. */
  function stop(threadId: string, outcome: { status: "stopped" | "limit-reached"; detail: string } = { status: "stopped", detail: "Stopped by you." }): boolean {
    const goal = live.get(threadId);
    if (!goal || goal.cancelled) return false;
    goal.cancelled = true;
    live.delete(threadId);
    finish(threadId, goal, outcome.status, outcome.detail);
    goal.wake?.();
    return true;
  }

  return { start, stop };
}

export type OneOnOneGoals = ReturnType<typeof createOneOnOneGoals>;
