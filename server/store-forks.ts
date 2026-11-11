import type { GroupTask as GroupTaskRecord } from "../shared/wire.ts";
import { newId } from "./contracts.ts";
import * as mdb from "./message-db.ts";
import type { BotRecord, Message, TaskRecord } from "./store.ts";
import { buildTask } from "./task-record.ts";
import { titleFromMessage } from "./thread-title.ts";
import type { ApprovalMode } from "../shared/approval-mode.ts";

function forkHistory(path: Message[], messageId: string): Message[] | null {
  const anchor = path.findIndex((message) => message.id === messageId);
  if (anchor < 0 || path[anchor]?.kind !== "text" || !["user", "bot"].includes(path[anchor]!.role)) return null;
  return structuredClone(path.slice(0, anchor + 1));
}

function registerImportedFork<T extends { threadId: string }>(task: T, history: Message[], messageId: string,
  register: (task: T) => void): void {
  mdb.importThread(task.threadId, history, messageId);
  try {
    register(task);
  } catch (error) {
    try { mdb.deleteThread(task.threadId); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "could not roll back the imported fork");
    }
    throw error;
  }
}

export function createGroupFork(source: GroupTaskRecord, path: Message[], messageId: string,
  register: (task: GroupTaskRecord) => void): GroupTaskRecord | null {
  const history = forkHistory(path, messageId);
  if (!history) return null;
  const createdAt = Date.now();
  const task: GroupTaskRecord = {
    threadId: newId(),
    title: titleFromMessage(history.at(-1)?.text ?? ""),
    createdAt,
    updatedAt: createdAt,
    origin: { threadId: source.threadId, messageId },
    lastReadMessageId: messageId,
    ...(source.pinnedCwd !== undefined ? { pinnedCwd: source.pinnedCwd } : {}),
  };
  registerImportedFork(task, history, messageId, register);
  return task;
}

export function createBotFork(bot: BotRecord, source: TaskRecord, path: Message[], messageId: string,
  approval: { mode: ApprovalMode; alwaysAllow: string[] },
  register: (task: TaskRecord) => void): TaskRecord | null {
  const history = forkHistory(path, messageId);
  if (!history) return null;
  const task = buildTask(bot, titleFromMessage(history.at(-1)?.text ?? ""), source.projectId, undefined,
    undefined, source.modelSelection, source.cwd ?? undefined);
  // A fork starts with the source's effective permissions, including an Ask mask for an unconfirmed grant.
  task.approvalMode = approval.mode;
  task.autoApprove = approval.mode === "auto";
  task.alwaysAllow = structuredClone(approval.alwaysAllow);
  task.outside = source.outside;
  task.botApi = source.botApi;
  task.origin = { threadId: source.threadId, messageId };
  task.lastReadMessageId = messageId;
  registerImportedFork(task, history, messageId, register);
  return task;
}
