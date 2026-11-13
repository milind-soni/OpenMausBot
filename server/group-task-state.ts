import type { GroupTask } from "../shared/wire.ts";
import type { GroupRecord, Store } from "./store.ts";

export function groupTasks(group: GroupRecord | undefined): GroupTask[] {
  return group?.dm ? [] : (group?.tasks ?? []);
}

export function activeGroupTask(group: GroupRecord | undefined): GroupTask | undefined {
  return group?.tasks?.find((task) => task.threadId === group.threadId);
}

export function groupTaskByThread(group: GroupRecord | undefined, threadId: string): GroupTask | undefined {
  return group?.dm ? undefined : group?.tasks?.find((task) => task.threadId === threadId);
}

export function mirrorActiveGroupTask(group: GroupRecord, task: GroupTask): void {
  Object.assign(group, { threadId: task.threadId, pinnedCwd: task.pinnedCwd, pinnedMessageId: task.pinnedMessageId,
    lastReadMessageId: task.lastReadMessageId });
}

export function migrateGroupTaskRead(group: GroupRecord, active: GroupTask): boolean {
  let changed = false;
  if (group.lastReadMessageId && !active.lastReadMessageId) {
    active.lastReadMessageId = group.lastReadMessageId;
    changed = true;
  }
  if (group.unread && !group.tasks?.some((task) => task.unread)) {
    active.unread = true;
    changed = true;
  }
  return changed;
}

export function syncGroupReadPatch(group: GroupRecord, patch: Partial<Pick<GroupRecord, "unread" | "lastReadMessageId">>): void {
  if (group.dm) return;
  const active = group.tasks?.find((task) => task.threadId === group.threadId);
  if (patch.unread !== undefined) {
    if (active) active.unread = patch.unread;
    group.unread = Boolean(group.tasks?.some((task) => task.unread));
  }
  if (patch.lastReadMessageId && active) active.lastReadMessageId = patch.lastReadMessageId;
}

export function setGroupTaskRead(group: GroupRecord, task: GroupTask, unread: boolean, lastReadMessageId?: string): void {
  task.unread = unread;
  group.unread = Boolean(group.tasks?.some((candidate) => candidate.unread));
  if (!unread && lastReadMessageId) {
    task.lastReadMessageId = lastReadMessageId;
    if (task.threadId === group.threadId) group.lastReadMessageId = lastReadMessageId;
  }
}

export function refreshGroupUnread(group: GroupRecord): void {
  group.unread = Boolean(group.tasks?.some((task) => task.unread));
}

export function markGroupThreadUnreadAfterTurn(store: Pick<Store, "patchGroup" | "markGroupThreadUnread">,
  groupId: string, threadId: string, busyBotId: string | null): void {
  store.patchGroup(groupId, { busyBotId });
  store.markGroupThreadUnread(groupId, threadId, true);
}
