// Where an automation's runs report: the chat a routine chose, else the bot's main chat. On a Cloud home a chat the
// owner writes in never gets words they did not choose, so a Mac they lend stays theirs there: a routine someone else
// wrote, and every outside event, report into a chat of their own.
import type { Routine, RoutineRun } from "./routines.ts";
import { threadTitleFrom, type Message, type Store, type TaskRecord } from "./store.ts";

export interface AutomationDestinationDeps {
  store: Pick<Store, "bot" | "createTask" | "messagesFor" | "taskByThread">;
  mainThread(botId: string): string | undefined;
  runs(): readonly Pick<RoutineRun, "webhookId" | "botId" | "resultsThreadId">[];
  /** Only on a Cloud home. */
  cloud: {
    owner: string;
    /** Who a routine's chat counts as opened by. */
    opener(routineId: string): string;
    reportFromOthers(line: Message): boolean;
    opened(threadId: string, person: string): void;
  } | null;
}

function legacyResultsThread(routineName: string, task: TaskRecord): boolean {
  return task.title.endsWith(" · Results") || task.title === threadTitleFrom(`${routineName} · Results`);
}

export function createAutomationDestinations(deps: AutomationDestinationDeps) {
  const { store, cloud } = deps;
  const chatOfItsOwn = (botId: string, name: string, person: string) => {
    const threadId = store.createTask(botId, `${name} · Results`, false)?.threadId;
    if (threadId) cloud?.opened(threadId, person);
    return threadId;
  };
  return {
    routine(routine: Routine, forceNew: boolean): { threadId: string; main?: true } | undefined {
      const bot = store.bot(routine.botId);
      const chosen = !forceNew && routine.resultsThreadId && bot && !bot.hidden ? store.taskByThread(bot.id, routine.resultsThreadId) : undefined;
      const opener = cloud?.opener(routine.id);
      const main = bot && !bot.hidden ? deps.mainThread(bot.id) : undefined;
      const mainAllowed = main && (!cloud || opener === cloud.owner);
      if (chosen && !chosen.routineRunId && !(mainAllowed && legacyResultsThread(routine.name, chosen))) return { threadId: chosen.threadId };
      if (mainAllowed) return { threadId: main, main: true };
      const threadId = cloud ? chatOfItsOwn(routine.botId, routine.name, opener!) : undefined;
      return threadId ? { threadId } : undefined;
    },
    event({ webhookId, webhookName, botId }: { webhookId: string; webhookName: string; botId: string }): string | undefined {
      const bot = store.bot(botId);
      if (!bot || bot.hidden) return undefined;
      if (!cloud) return deps.mainThread(botId);
      const earlier = deps.runs().find((run) => run.webhookId === webhookId && run.botId === botId && run.resultsThreadId)?.resultsThreadId;
      const kept = earlier ? store.taskByThread(botId, earlier) : undefined;
      const lines = kept && !kept.routineRunId ? store.messagesFor(kept.threadId) : undefined;
      if (kept && lines && (lines.length === 0 || lines.some(cloud.reportFromOthers))) return kept.threadId;
      return chatOfItsOwn(botId, webhookName, cloud.owner);
    },
  };
}
