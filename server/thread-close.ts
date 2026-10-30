import { ESCALATIONS_THREAD_TITLE } from "./escalations.ts";
import { INCIDENTS_THREAD_TITLE } from "./incidents.ts";
import type { Coordinator } from "./coordinator.ts";
import type { BotRecord, Store, TaskRecord } from "./store.ts";

const NOTICE_TITLES: ReadonlySet<string> = new Set([INCIDENTS_THREAD_TITLE, ESCALATIONS_THREAD_TITLE]);

export function isNoticeThread(task: TaskRecord): boolean {
  return NOTICE_TITLES.has(task.title);
}

export interface CloseGuards {
  coordinator: Pick<Coordinator, "awaitingAnswer" | "activeDirect">;
  threadBusy(botId: string, threadId: string): boolean;
  queuedThreadPosition(botId: string, threadId: string): number | null;
}

export function closeRefusal(guards: CloseGuards, botId: string, task: TaskRecord): string | null {
  if (guards.coordinator.awaitingAnswer(task.threadId)) {
    return `#${task.title} is waiting on the person's answer to its question — it continues once they reply there, so leave it open`;
  }
  if (guards.threadBusy(botId, task.threadId) || guards.queuedThreadPosition(botId, task.threadId) !== null || guards.coordinator.activeDirect(task.threadId)) {
    return `#${task.title} is still running — wait for it to finish (list_threads), or the person can stop it from the app`;
  }
  return null;
}

export function closeThread(
  store: Pick<Store, "appendMessage" | "patchTask" | "setTaskClosedBy">,
  botId: string,
  task: TaskRecord,
  closer: BotRecord,
): void {
  store.appendMessage(task.threadId, {
    role: "bot",
    kind: "activity",
    from: { botId: closer.id, name: closer.name, color: closer.color },
    tool: { name: `Closed by @${closer.name}`, ok: true },
  });
  if (task.unread) store.patchTask(botId, task.threadId, { unread: false });
  store.setTaskClosedBy(botId, task.threadId, { botId: closer.id, name: closer.name, at: Date.now() });
}
