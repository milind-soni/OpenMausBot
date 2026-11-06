import type { ModelSelection } from "../contracts.ts";
import type { ProviderRegistry } from "../harness/registry.ts";
import { canManage, reachRefusal } from "../peer-roster.ts";
import type { QuickModelFallback } from "../quick-model-fallback.ts";
import type { RoutineRun } from "../routines.ts";
import type { BotRecord, Store } from "../store.ts";
import { quickStepModel } from "../turn-route.ts";

export interface RoutineThreadsDeps {
  store: Pick<Store, "bot" | "botByThread" | "taskByThread" | "groupByThread">;
  registry: Pick<ProviderRegistry, "get">;
  quickFallback: Pick<QuickModelFallback, "refused">;
  /** The selection checked like any model change, or null when the bot may not move to it. */
  allowedModel: (selection: ModelSelection, bot: BotRecord) => ModelSelection | null;
}

/** Which chat a routine's run reports to, and which bot and model each of its steps runs on. */
export function createRoutineThreads({ store, registry, quickFallback, allowedModel }: RoutineThreadsDeps) {
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

  /** The model a routine step's thread runs on, labelled as the picker shows it: a quick step with no usable quick model runs on the bot's own. */
  function routineStepModel(botId: string, quick: boolean): { selection?: ModelSelection; label: string } | undefined {
    const bot = store.bot(botId), instance = bot ? registry.get(bot.modelSelection.instanceId) : undefined;
    if (!bot || !instance) return undefined;
    const label = (model: string) => instance.models?.options.find((option) => option.id === model)?.label ?? model;
    const fast = quick ? quickStepModel(instance, bot.modelSelection.model, quickFallback.refused(instance.instanceId)) : undefined;
    const selection = fast ? allowedModel({ instanceId: instance.instanceId, model: fast }, bot) : null;
    return fast && selection ? { selection, label: label(fast) } : { label: label(bot.modelSelection.model) };
  }

  /** Why the owner may not hand a step to this bot, the same reach rule as coordinate_bots; null when it may. */
  function routineStepBotProblem(ownerBotId: string, stepBotId: string): string | null {
    const owner = store.bot(ownerBotId), bot = store.bot(stepBotId);
    if (!bot) return `No bot with id "${stepBotId}" — call list_bots and copy the exact id from the result`;
    return owner ? reachRefusal(owner, bot) : null;
  }

  return { routineSourceOwner, routineSourceThread, routineStepModel, routineStepBotProblem };
}
