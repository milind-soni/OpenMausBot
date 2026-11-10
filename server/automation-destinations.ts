// Where an automation's runs report: the chat a routine chose, else the bot's main chat; every outside event, into a
// chat of its own. On a Cloud home a chat the owner writes in never gets words they did not choose, so a Mac they lend
// stays theirs there: a routine someone else wrote reports into a chat of its own too.
import { CLOUD_OUTSIDE_KEY } from "./cloud-sharing.ts";
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
    /** This chat holds what an outside event's run reported. */
    outside(threadId: string): void;
  } | null;
}

function legacyResultsThread(routineName: string, task: TaskRecord): boolean {
  return task.title.endsWith(" · Results") || task.title === threadTitleFrom(`${routineName} · Results`);
}

export function createAutomationDestinations(deps: AutomationDestinationDeps) {
  const { store, cloud } = deps;
  const chatOfItsOwn = (botId: string, name: string, person?: string) => {
    return store.createTask(botId, `${name} · Results`, false, undefined, undefined, undefined, undefined, undefined,
      person ? (created) => cloud?.opened(created.threadId, person) : undefined)?.threadId;
  };
  return {
    /** The chat of its own an outside event's run reports into on a Cloud: never the person's, and never a wait's, which reports to the chat that set it. */
    eventChat(run: Pick<RoutineRun, "botId" | "routineName" | "resultsThreadId" | "eventSource">): string | undefined {
      const task = cloud && run.eventSource !== "wait" && run.resultsThreadId ? store.taskByThread(run.botId, run.resultsThreadId) : undefined;
      return task && legacyResultsThread(run.routineName, task) ? task.threadId : undefined;
    },
    routine(routine: Routine, forceNew: boolean): { threadId: string; main?: true } | undefined {
      const bot = store.bot(routine.botId);
      const opener = cloud?.opener(routine.id);
      // A routine outside work wrote reports nowhere a person already works, whatever chat it names.
      const chosen = !forceNew && opener !== CLOUD_OUTSIDE_KEY && routine.resultsThreadId && bot && !bot.hidden ? store.taskByThread(bot.id, routine.resultsThreadId) : undefined;
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
      const earlier = deps.runs().find((run) => run.webhookId === webhookId && run.botId === botId && run.resultsThreadId)?.resultsThreadId;
      const kept = earlier ? store.taskByThread(botId, earlier) : undefined;
      const lines = kept && !kept.routineRunId ? store.messagesFor(kept.threadId) : undefined;
      const stillItsOwn = kept && lines && (cloud ? lines.length === 0 || lines.some(cloud.reportFromOthers) : legacyResultsThread(webhookName, kept));
      const threadId = stillItsOwn ? kept.threadId : chatOfItsOwn(botId, webhookName, cloud?.owner);
      if (threadId) cloud?.outside(threadId);
      return threadId;
    },
  };
}
