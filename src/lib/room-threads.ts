import { t } from "@/lib/i18n";
import type { Group, GroupTask } from "@/state/store";
import type { RoomQueueEntry } from "../../shared/wire";

type RoomThreads = Pick<Group, "threadId" | "working" | "busyBotId" | "tasks">;
type RoomThread = Pick<GroupTask, "threadId" | "working" | "busyBotId">;

function reportsPerThread(task: RoomThread | undefined): task is RoomThread {
  return Boolean(task) && (typeof task!.working === "boolean" || task!.busyBotId !== undefined);
}

function taskOf(group: RoomThreads, threadId: string): RoomThread | undefined {
  return group.tasks?.find((task) => task.threadId === threadId);
}

export function roomThreadWorking(group: RoomThreads, threadId: string): boolean {
  const task = taskOf(group, threadId);
  if (reportsPerThread(task)) return Boolean(task.working || task.busyBotId);
  return threadId === group.threadId && Boolean(group.working || group.busyBotId);
}

export function roomThreadSpeakerId(group: RoomThreads, threadId: string): string | null {
  const task = taskOf(group, threadId);
  if (reportsPerThread(task)) return task.busyBotId ?? null;
  return threadId === group.threadId ? group.busyBotId ?? null : null;
}

export function roomSpeakerIds(group: RoomThreads): string[] {
  const ids = [group.busyBotId, ...(group.tasks ?? []).map((task) => task.busyBotId)]
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return [...new Set(ids)];
}

export function roomThreadsWorkingElsewhere(group: RoomThreads): number {
  return (group.tasks ?? []).filter((task) => task.threadId !== group.threadId && roomThreadWorking(group, task.threadId)).length;
}

export function roomThreadQueue(group: Pick<Group, "queue">, threadId: string): RoomQueueEntry[] {
  return (group.queue ?? []).filter((entry) => entry.threadId === threadId && entry.state === "queued");
}

export function roomQueueLabel(entry: RoomQueueEntry, nameOf: (botId: string) => string | undefined): string {
  const name = entry.waitingForBotId ? nameOf(entry.waitingForBotId) : undefined;
  return name
    ? t("room.queue.waitingFor", { name, position: entry.position, of: entry.of })
    : t("room.queue.waiting", { position: entry.position, of: entry.of });
}

export function roomWorkingPreview(group: RoomThreads & Pick<Group, "queue">, nameOf: (botId: string) => string | undefined): string | undefined {
  const speakerId = group.busyBotId ?? roomSpeakerIds(group)[0];
  const queued = (group.queue ?? []).filter((entry) => entry.state === "queued");
  if (speakerId) {
    const name = nameOf(speakerId) ?? t("sidebar.preview.aBot");
    return queued.length ? t("sidebar.preview.botWorkingQueued", { name, count: queued.length }) : t("sidebar.preview.botWorking", { name });
  }
  if (queued[0]) return t("room.queue.member", { name: nameOf(queued[0].botId) ?? t("sidebar.preview.aBot"), status: roomQueueLabel(queued[0], nameOf) });
  return undefined;
}
