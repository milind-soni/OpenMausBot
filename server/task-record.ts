import { approvalModeFor } from "../shared/approval-mode.ts";
import { sameModelSelection } from "../shared/thread-model.ts";
import type { TaskOpenedBy } from "../shared/wire.ts";
import { newId, type ModelSelection } from "./contracts.ts";
import type { BotRecord, TaskRecord } from "./store.ts";

export const UNTITLED_THREAD = "New thread";
const TASK_TITLE_MAX = 80;

export function threadTitleFrom(title?: string): string {
  return title?.trim().slice(0, TASK_TITLE_MAX) || UNTITLED_THREAD;
}

/** A new thread starts at its bot's level. A pending grant is not that level: a composer grant belongs to its own
 * thread, and a bot-wide one may still roll back, so a thread made meanwhile follows the bot live instead of keeping
 * the Ask mask the grant shows (or a Full access that was never confirmed). */
function botLevel(bot: BotRecord): Pick<TaskRecord, "approvalMode" | "autoApprove" | "alwaysAllow"> {
  if (bot.approvalGrant && !bot.approvalGrant.threadOnly) return {};
  return { approvalMode: approvalModeFor({ ...bot, approvalGrant: undefined }), autoApprove: Boolean(bot.autoApprove), alwaysAllow: [...(bot.alwaysAllow ?? [])] };
}

export function buildTask(bot: BotRecord, title?: string, projectId?: string, openedBy?: TaskOpenedBy,
  approvalMode?: "ask" | "full", modelSelection?: ModelSelection, cwd?: string | null): TaskRecord {
  const createdAt = Date.now();
  return {
    threadId: newId(),
    title: threadTitleFrom(title),
    createdAt,
    updatedAt: createdAt,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(projectId ? { projectId } : {}),
    ...(openedBy ? { openedBy: structuredClone(openedBy) } : {}),
    resumeCursors: {},
    ...(modelSelection && !sameModelSelection(modelSelection, bot.modelSelection) ? { modelSelection: structuredClone(modelSelection) } : {}),
    ...(approvalMode ? { approvalMode, autoApprove: false, alwaysAllow: [] } : botLevel(bot)),
    unread: false,
    activity: "idle",
    busy: false,
  };
}
