import type { GroupTask as GroupTaskRecord } from "../shared/wire.ts";
import { newId } from "./contracts.ts";
import * as mdb from "./message-db.ts";
import type { BotRecord, Message, TaskRecord } from "./store.ts";
import { buildTask } from "./task-record.ts";
import { titleFromMessage } from "./thread-title.ts";

function forkHistory(path: Message[], messageId: string): Message[] | null {
  const anchor = path.findIndex((message) => message.id === messageId);
  if (anchor < 0 || path[anchor]?.kind !== "text" || !["user", "bot"].includes(path[anchor]!.role)) return null;
  return structuredClone(path.slice(0, anchor + 1));
}

/** Import the copied message path and register the task in the same database transaction. */
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
    ...(source.pinnedCwd !== undefined ? { pinnedCwd: source.pinnedCwd } : {}),
  };
  mdb.importThread(task.threadId, history, messageId, undefined, () => register(task));
  return task;
}

export function createBotFork(bot: BotRecord, source: TaskRecord, path: Message[], messageId: string,
  register: (task: TaskRecord) => void): TaskRecord | null {
  const history = forkHistory(path, messageId);
  if (!history) return null;
  const task = buildTask(bot, titleFromMessage(history.at(-1)?.text ?? ""), source.projectId, undefined,
    undefined, source.modelSelection, source.cwd ?? undefined);
  task.origin = { threadId: source.threadId, messageId };
  task.lastReadMessageId = messageId;
  mdb.importThread(task.threadId, history, messageId, undefined, () => register(task));
  return task;
}
