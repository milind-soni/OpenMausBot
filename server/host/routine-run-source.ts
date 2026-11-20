import { routineRunNeedsReview } from "../automation-reports.ts";
import { routineRunCard, routineRunFallbackText } from "../routine-run-card.ts";
import type { RoutineRun } from "../routines.ts";
import type { BotRecord, Message, Store } from "../store.ts";

export function createRoutineRunSource({ store, canManage, speaksFor, threadLanguage }: {
  store: Pick<Store, "bot" | "botByThread" | "taskByThread" | "groupByThread" | "messagesFor" | "patchTask" | "patchMessage" | "appendMessage" | "markGroupThreadUnread">;
  canManage: (source: BotRecord, bot: BotRecord) => boolean;
  speaksFor: (run: RoutineRun) => boolean;
  threadLanguage: (threadId: string) => string | undefined;
}) {
  function routineSourceOwner(run: Pick<RoutineRun, "botId" | "sourceThreadId" | "resultsThreadId">) {
    if (run.resultsThreadId) {
      const bot = store.bot(run.botId);
      const task = bot && store.taskByThread(bot.id, run.resultsThreadId);
      return bot && !bot.hidden && task && !task.routineRunId
        ? { bot, group: undefined, threadId: task.threadId }
        : null;
    }
    const threadId = run.sourceThreadId?.trim();
    if (!threadId) return null;
    // Validate before messagesFor(): Store lazily opens transcript storage, so an orphan id would recreate a deleted conversation.
    const bot = store.bot(run.botId);
    if (!bot) return null;
    // Stamped from the confirmed request, never calendar input; recheck authority, since either bot may have moved since.
    const sourceBot = store.botByThread(threadId);
    if (sourceBot && !sourceBot.hidden && !store.taskByThread(sourceBot.id, threadId)?.routineRunId &&
      (sourceBot.id === bot.id || canManage(sourceBot, bot))) {
      return { bot: sourceBot, group: undefined, threadId };
    }
    const group = store.groupByThread(threadId);
    return group?.memberIds.includes(bot.id) ? { bot, group, threadId } : null;
  }

  function routineSourceThread(run: RoutineRun): string | null {
    return routineSourceOwner(run)?.threadId ?? null;
  }

  function syncRoutineRunToSource(run: RoutineRun): string | null {
    const source = routineSourceOwner(run);
    if (!source) {
      const execution = run.threadId ? store.taskByThread(run.botId, run.threadId) : null;
      if (execution?.routineRunId === run.id) {
        store.patchTask(run.botId, execution.threadId, {
          routineRunId: undefined,
          ...(routineRunNeedsReview(run) ? { unread: true } : {}),
        });
      }
      return null;
    }
    const sourceThreadId = source.threadId;
    const existing = store.messagesFor(sourceThreadId).find((message) => message.kind === "routine.run" && message.routineRun?.runId === run.id);
    // A bot's run speaks in its own lines; a room goal, a run that began before those existed, and one with no chat of its bot to speak in that works elsewhere keep a card.
    const card = existing || run.target === "room-goal" || (run.threadId !== sourceThreadId && !speaksFor(run)) ? routineRunCard(run) : null;
    const statusChanged = card !== null && existing?.routineRun?.status !== run.status;
    if (existing && card) {
      store.patchMessage(sourceThreadId, existing.id, { text: routineRunFallbackText(card, threadLanguage(sourceThreadId)), routineRun: card });
    } else if (card) {
      const message: Omit<Message, "id" | "at"> = { role: "bot", kind: "routine.run", text: routineRunFallbackText(card, threadLanguage(sourceThreadId)), routineRun: card };
      if (source.group) {
        message.from = { botId: source.bot.id, name: source.bot.name, color: source.bot.color };
      }
      store.appendMessage(sourceThreadId, message);
    }

    // Mark only the fresh execution: on its first running update, before dispatch adds any transcript.
    if (run.target === "bot" && run.threadId && run.threadId !== sourceThreadId) {
      const execution = store.taskByThread(run.botId, run.threadId);
      const freshExecution = execution && run.status === "running" && (run.sameConversation ? execution.routineRunId !== run.id /* takes the conversation over */ : !execution.routineRunId && store.messagesFor(run.threadId).length === 0);
      if (execution && freshExecution) {
        store.patchTask(run.botId, run.threadId, { routineRunId: run.id, unread: false });
      } else if (execution?.routineRunId === run.id && execution.unread) {
        store.patchTask(run.botId, run.threadId, { unread: false });
      }
    }

    if (statusChanged && (source.group ? ["waiting", "completed", "failed", "missed"].includes(run.status) : routineRunNeedsReview(run))) {
      if (source.group) store.markGroupThreadUnread(source.group.id, sourceThreadId, true);
      else store.patchTask(source.bot.id, sourceThreadId, { unread: true });
    }
    return sourceThreadId;
  }
  return { routineSourceOwner, routineSourceThread, syncRoutineRunToSource };
}
