// Group (room) records and their channel tasks: creation, patching,
// per-room task switching, and crash recovery for interrupted room goals.
import * as mdb from "../message-db.ts";
import { newId } from "../contracts.ts";
import type { GroupGoalRunCardData } from "../../shared/group-goal-run.ts";
import type { GroupDefaultResponder, GroupTask as GroupTaskRecord } from "../../shared/wire.ts";
import {
  normalizeGroupDefaultResponder, titleFromMessage, UNTITLED_TASK,
  type GroupRecord,
} from "./records.ts";
import type { StoreContext } from "./context.ts";
import { clearPendingThreadDeletions, flushPendingThreadDeletions, stagePendingThreadDeletions } from "./messages.ts";

export function group(ctx: StoreContext, id: string): GroupRecord | undefined {
  return ctx.groups.find((g) => g.id === id);
}

export function groupByThread(ctx: StoreContext, threadId: string): GroupRecord | undefined {
  return ctx.groups.find(
    (candidate) => candidate.threadId === threadId || candidate.tasks?.some((task) => task.threadId === threadId),
  );
}

export function createGroup(
  ctx: StoreContext,
  name: string,
  memberIds: string[],
  dm = false,
  section?: string,
  setup?: {
    bulletin?: string;
    defaultResponder?: GroupDefaultResponder;
    completed?: boolean;
  },
): GroupRecord {
  ctx.rememberSections([section]);
  const threadId = newId();
  const createdAt = Date.now();
  const record: GroupRecord = {
    id: newId(),
    threadId,
    name,
    memberIds,
    defaultResponder: dm
      ? { kind: "mentions" }
      : normalizeGroupDefaultResponder(setup?.defaultResponder, memberIds, false),
    bulletin: setup?.bulletin ?? "",
    unread: false,
    createdAt,
    dm: dm || undefined,
    busyBotId: null,
    section,
  };
  if (!dm) {
    record.tasks = [{ threadId, title: UNTITLED_TASK, createdAt }];
    record.setupCompletedAt = setup?.completed ? createdAt : null;
    record.setupSkippedAt = null;
  }
  ctx.groups.unshift(record);
  ctx.saveGroups();
  ctx.emit({ type: "group", groupId: record.id });
  return record;
}

/** The bot⇄bot channel for a pair, if it exists (order-insensitive). */
export function dmGroup(ctx: StoreContext, a: string, b: string): GroupRecord | undefined {
  return ctx.groups.find(
    (g) => g.dm && g.memberIds.length === 2 && g.memberIds.includes(a) && g.memberIds.includes(b),
  );
}

export function patchGroup(ctx: StoreContext, id: string, patch: Partial<Pick<GroupRecord, "name" | "memberIds" | "defaultResponder" | "bulletin" | "unread" | "busyBotId" | "cwd" | "pinnedMessageId" | "section" | "setupCompletedAt" | "setupSkippedAt">>): GroupRecord | null {
  const record = ctx.group(id);
  if (!record) return null;
  if (Object.prototype.hasOwnProperty.call(patch, "section")) {
    ctx.rememberSections([patch.section]);
  }
    const previousBusyBotId = record.busyBotId;
  Object.assign(record, patch);
    // The group's elapsed readout counts the busy member's turn from the
    // claim time — the group-side twin of a task's turnStartedAt. Derived,
    // never patched directly: stamp it on every transition into a busy
    // speaker and clear it when the group goes idle, so each member's turn
    // counts from its own start.
    if (Object.prototype.hasOwnProperty.call(patch, "busyBotId")) {
      if (patch.busyBotId && patch.busyBotId !== previousBusyBotId) record.turnStartedAt = Date.now();
      else if (!patch.busyBotId) delete record.turnStartedAt;
    }

  if (!record.dm && Object.prototype.hasOwnProperty.call(patch, "pinnedMessageId")) {
    const active = ctx.activeGroupTask(id);
    if (active) active.pinnedMessageId = patch.pinnedMessageId;
  }
  record.defaultResponder = normalizeGroupDefaultResponder(
    record.defaultResponder,
    record.memberIds,
    Boolean(record.dm),
  );
  ctx.saveGroups();
  ctx.emit({ type: "group", groupId: record.id });
  return record;
}

export function deleteGroup(ctx: StoreContext, id: string): boolean {
  const resumed = flushPendingThreadDeletions(ctx, id);
  const record = ctx.group(id);
  if (!record) {
    // No record and nothing flushed: nothing to delete. A non-empty flush
    // means a prior attempt removed the group and died before finishing
    // its thread cleanup — this retry completes the finalization and still
    // notifies clients.
    if (resumed.length === 0) return false;
    ctx.emit({ type: "group.deleted", groupId: id });
    return true;
  }
  // Every thread the group owns, deduped, staged durably BEFORE the group
  // leaves groups.json: a crash mid-delete leaves the tombstone behind, so
  // the next retry takes the no-record branch above and finishes.
  const ownedThreads = [...new Set([record.threadId, ...(record.tasks ?? []).map((task) => task.threadId)])];
  stagePendingThreadDeletions(id, ownedThreads);
  const index = ctx.groups.indexOf(record);
  // Snapshot the in-memory threads so a failure inside this call restores the
  // full retryable shape; the durable tombstone above keeps a crash between
  // phases retryable as well.
  const snapshots = ownedThreads.map((threadId) => ({ threadId, state: ctx.threads.get(threadId) }));
  try {
    for (const { threadId } of snapshots) {
      ctx.deleteThreadRecord(threadId);
    }
  } catch (error) {
    for (const { threadId, state } of snapshots) {
      if (state) ctx.threads.set(threadId, state);
    }
    throw error;
  }
  ctx.groups = ctx.groups.filter((g) => g.id !== id);
  try {
    ctx.saveGroups();
  } catch (error) {
    // The in-memory group is restored so groups.json stays authoritative and a
    // retry can find it; the tombstone stays staged because the threads are
    // already durably gone.
    ctx.groups.splice(index, 0, record);
    throw error;
  }
  clearPendingThreadDeletions(id, ownedThreads);
  ctx.emit({ type: "group.deleted", groupId: id });
  return true;
}

/** A process restart cannot preserve an in-flight room orchestrator. Close
 * every durable working receipt before clients load it, including manual
 * goals that do not have a RoutineRun record to reconcile separately. */
export function reconcileInterruptedGroupGoals(
  ctx: StoreContext,
  resolve?: (
    runId: string,
    threadId: string,
  ) => {
    status: Exclude<GroupGoalRunCardData["status"], "working">;
    detail: string;
    finishedAt: number;
  } | null,
  fallbackDetail = "OpenMausBot restarted before this goal finished.",
  fallbackFinishedAt = Date.now(),
): number {
  const ownedThreadIds = new Set<string>();
  for (const candidate of ctx.groups) {
    ownedThreadIds.add(candidate.threadId);
    for (const task of candidate.tasks ?? []) ownedThreadIds.add(task.threadId);
  }
  // load() already migrated every legacy transcript file into SQLite, so
  // this recovery query is proportional to unfinished goals, not history.
  let recovered = 0;
  for (const hit of mdb.workingGoalRunMessages()) {
    if (!ownedThreadIds.has(hit.threadId) || !hit.message.goalRun) continue;
    const resolution = resolve?.(hit.message.goalRun.runId, hit.threadId) ?? {
      status: "failed" as const,
      detail: fallbackDetail,
      finishedAt: fallbackFinishedAt,
    };
    const state = resolution.status === "needs-input"
      ? "needs your input"
      : resolution.status === "limit-reached"
        ? "reached its turn limit"
        : resolution.status;
    ctx.patchMessage(hit.threadId, hit.message.id, {
      text: `Goal ${state}: ${resolution.detail}`,
      goalRun: {
        ...hit.message.goalRun,
        status: resolution.status,
        detail: resolution.detail,
        finishedAt: resolution.finishedAt,
      },
    });
    recovered += 1;
  }
  return recovered;
}

// ── channel tasks ────────────────────────────────────────────────────
export function groupTasks(ctx: StoreContext, groupId: string): GroupTaskRecord[] {
  const record = ctx.group(groupId);
  return record?.dm ? [] : (record?.tasks ?? []);
}

export function activeGroupTask(ctx: StoreContext, groupId: string): GroupTaskRecord | undefined {
  const record = ctx.group(groupId);
  return record?.tasks?.find((task) => task.threadId === record.threadId);
}

export function groupTaskByThread(ctx: StoreContext, groupId: string, threadId: string): GroupTaskRecord | undefined {
  const record = ctx.group(groupId);
  if (!record || record.dm) return undefined;
  return record.tasks?.find((task) => task.threadId === threadId);
}

export function createGroupTask(ctx: StoreContext, groupId: string, title?: string, activate = true): GroupTaskRecord | null {
  const record = ctx.group(groupId);
  if (!record || record.dm) return null;
  const task: GroupTaskRecord = {
    threadId: newId(),
    title: title?.trim().slice(0, 80) || UNTITLED_TASK,
    createdAt: Date.now(),
  };
  record.tasks = [task, ...(record.tasks ?? [])];
  if (activate) {
    record.threadId = task.threadId;
    record.pinnedCwd = undefined;
    record.pinnedMessageId = undefined;
  }
  ctx.saveGroups();
  ctx.emit({ type: "group", groupId });
  return task;
}

export function switchGroupTask(ctx: StoreContext, groupId: string, threadId: string): GroupRecord | null {
  const record = ctx.group(groupId);
  const task = record?.tasks?.find((candidate) => candidate.threadId === threadId);
  if (!record || record.dm || !task) return null;
  record.threadId = task.threadId;
  record.pinnedCwd = task.pinnedCwd;
  record.pinnedMessageId = task.pinnedMessageId;
  ctx.saveGroups();
  ctx.emit({ type: "group", groupId });
  return record;
}

export function renameGroupTask(ctx: StoreContext, groupId: string, threadId: string, title: string): GroupTaskRecord | null {
  const task = ctx.groupTaskByThread(groupId, threadId);
  if (!task) return null;
  task.title = title.trim().slice(0, 80) || UNTITLED_TASK;
  ctx.saveGroups();
  ctx.emit({ type: "group", groupId });
  return task;
}

/** Name a channel task after its first message, once. Returns the task
 * it named so a caller can later replace exactly that machine-made
 * title. */
export function titleGroupTaskFromFirstMessage(ctx: StoreContext, groupId: string, text: string, threadId?: string): GroupTaskRecord | null {
  const task = threadId ? ctx.groupTaskByThread(groupId, threadId) : ctx.activeGroupTask(groupId);
  if (!task || task.titleFromFirstMessage || task.title !== UNTITLED_TASK) return null;
  task.title = titleFromMessage(text);
  task.titleFromFirstMessage = true;
  ctx.saveGroups();
  ctx.emit({ type: "group", groupId });
  return task;
}

/** Swap a machine-made first-message channel title for a generated one,
 * once, on the same snippet-equality contract as bot tasks: any rename
 * by the person breaks that equality first and always wins. */
export function retitleGroupTask(ctx: StoreContext, groupId: string, threadId: string, machineTitle: string, title: string): GroupTaskRecord | null {
  const task = ctx.groupTaskByThread(groupId, threadId);
  if (!task || task.title !== machineTitle) return null;
  return renameGroupTask(ctx, groupId, threadId, title);
}

export function deleteGroupTask(ctx: StoreContext, groupId: string, threadId: string): GroupRecord | null {
  flushPendingThreadDeletions(ctx, groupId);
  const record = ctx.group(groupId);
  if (!record || record.dm || !record.tasks || record.tasks.length < 2) return null;
  if (!record.tasks.some((task) => task.threadId === threadId)) return null;
  // The filter and active-thread reassignment below reshape the record;
  // snapshot the pre-delete shape so a failed save restores it exactly.
  const prev: {
    tasks: GroupTaskRecord[];
    threadId: string;
    pinnedCwd: string | null | undefined;
    pinnedMessageId: string | undefined;
  } = {
    tasks: record.tasks,
    threadId: record.threadId,
    pinnedCwd: record.pinnedCwd,
    pinnedMessageId: record.pinnedMessageId,
  };
  record.tasks = record.tasks.filter((task) => task.threadId !== threadId);
  if (record.threadId === threadId) {
    const next = record.tasks[0]!;
    record.threadId = next.threadId;
    record.pinnedCwd = next.pinnedCwd;
    record.pinnedMessageId = next.pinnedMessageId;
  }
  stagePendingThreadDeletions(groupId, [threadId]);
  try {
    ctx.saveGroups();
  } catch (error) {
    record.tasks = prev.tasks;
    record.threadId = prev.threadId;
    record.pinnedCwd = prev.pinnedCwd;
    record.pinnedMessageId = prev.pinnedMessageId;
    clearPendingThreadDeletions(groupId, [threadId]);
    throw error;
  }
  ctx.deleteThreadRecord(threadId);
  clearPendingThreadDeletions(groupId, [threadId]);
  ctx.emit({ type: "group", groupId });
  return record;
}

/** The folder a room's member turns run in. Pins on the first turn that
 * dispatches, from the room's `cwd` at that moment. Pinned, not read
 * live, for the same reason tasks pin (see pinTaskCwd): engines key
 * their sessions and files to the folder a thread starts in, and a room
 * lives on ONE thread forever — so changing the room's folder applies to
 * future rooms, never under a room that already started working
 * somewhere. Returns the pinned value: a path, or null = each member's
 * own default. */
export function pinGroupCwd(ctx: StoreContext, groupId: string, threadId?: string): string | null {
  const record = ctx.group(groupId);
  if (!record) return null;
  const task = threadId ? ctx.groupTaskByThread(groupId, threadId) : ctx.activeGroupTask(groupId);
  // Direct-message channels retain the original single-thread contract.
  if (!task) {
    if (!record.dm) return null;
    if (record.pinnedCwd === undefined) {
      record.pinnedCwd = record.cwd ?? null;
      ctx.saveGroups();
      ctx.emit({ type: "group", groupId: record.id });
    }
    return record.pinnedCwd;
  }
  if (task.pinnedCwd === undefined) {
    task.pinnedCwd = record.cwd ?? null;
    if (record.threadId === task.threadId) record.pinnedCwd = task.pinnedCwd;
    ctx.saveGroups();
    ctx.emit({ type: "group", groupId: record.id });
  }
  return task.pinnedCwd;
}
