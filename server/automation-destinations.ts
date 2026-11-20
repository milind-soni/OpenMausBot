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
    personChat(botId: string, person: string): string | undefined;
    /** Who a routine's chat counts as opened by. */
    opener(routineId: string, routine?: Routine): string;
    reportFromOthers(line: Message): boolean;
    opened(threadId: string, person: string): void;
    /** This chat holds what an outside event's run reported. */
    outside(threadId: string): void;
  } | null;
}

function legacyResultsThread(routineName: string, task: Pick<TaskRecord, "title">): boolean {
  return task.title.endsWith(" · Results") || task.title === threadTitleFrom(`${routineName} · Results`);
}

/** The chat a routine opened for its own results, which no person has written in. */
export function isOwnResultsChat(routineName: string, task: Pick<TaskRecord, "title" | "askedAt">): boolean {
  return legacyResultsThread(routineName, task) && task.askedAt === undefined;
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
      const opener = cloud?.opener(routine.id, routine);
      if (!bot || bot.hidden) return undefined;
      const chosen = !forceNew && opener !== CLOUD_OUTSIDE_KEY && routine.resultsThreadId
        ? store.taskByThread(bot.id, routine.resultsThreadId) : undefined;
      const main = !cloud || opener === cloud.owner ? deps.mainThread(bot.id) : undefined;
      const personal = cloud && opener !== cloud.owner && opener ? cloud.personChat(bot.id, opener) : undefined;
      if (personal) return { threadId: personal };
      if (chosen && !chosen.routineRunId && (!main || !legacyResultsThread(routine.name, chosen))) {
        return { threadId: chosen.threadId };
      }
      if (main) return { threadId: main, main: true };
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
      const stillItsOwn = kept && lines && (lines.length === 0 || lines.some(cloud.reportFromOthers));
      const threadId = stillItsOwn ? kept.threadId : chatOfItsOwn(botId, webhookName, cloud?.owner);
      if (threadId) cloud?.outside(threadId);
      return threadId;
    },
  };
}
